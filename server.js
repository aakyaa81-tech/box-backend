const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");
const cron = require("node-cron");
const { createProxyMiddleware } = require('http-proxy-middleware');
const rateLimit = require('express-rate-limit');
const crypto = require("crypto");
require('dotenv').config();
const bs58Module = require("bs58");
const bs58 = bs58Module.default || bs58Module;
global.fetch = require("cross-fetch");

// ---- NEW: admin dashboard dependencies ----
const http = require("http");
const { Server: SocketIOServer } = require("socket.io");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const { Connection, PublicKey, Transaction, SystemProgram, Keypair, VersionedTransaction } = require('@solana/web3.js');

const {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAccount
} = require("@solana/spl-token");

const app = express();
app.set('trust proxy', 1);  
app.use(cors());
app.use(express.json());
const escrowSecret = Uint8Array.from(
  JSON.parse(process.env.ESCROW_PRIVATE_KEY)
);

const escrowKeypair = Keypair.fromSecretKey(
  escrowSecret
);

const STARTING_PRICE = parseFloat(process.env.STARTING_PRICE) || 0.001;
const MAX_PRICE = parseFloat(process.env.MAX_PRICE) || 1;
const CHAMPION_MAX_PRICE = parseFloat(process.env.CHAMPION_MAX_PRICE) || 2;
const PRICE_MULTIPLIER = parseFloat(process.env.PRICE_MULTIPLIER) || 1.4;
const DEFENSE_HOURS = parseFloat(process.env.DEFENSE_HOURS) || 0.0083;
const DEFENSE_NEEDED = parseInt(process.env.DEFENSE_NEEDED) || 5;
const SLIPPAGE_BPS = parseInt(process.env.SLIPPAGE_BPS) || 50;
const CREATOR_WALLET = process.env.CREATOR_WALLET || "DZLUTtcQ4aULLS1eqArsq8KiKKqoSqvEms44PHmHoQqe";

// ---- NEW: admin dashboard config ----
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET;
if (!ADMIN_JWT_SECRET) {
  console.warn("⚠️  ADMIN_JWT_SECRET is not set. Admin dashboard auth will fail until you set it.");
}
const ADMIN_JWT_EXPIRES_IN = process.env.ADMIN_JWT_EXPIRES_IN || "12h";
const BOX_MINT_DECIMALS = parseInt(process.env.BOX_MINT_DECIMALS) || 6;

console.log(`⚙️ Config loaded: DEFENSE_HOURS=${DEFENSE_HOURS}, DEFENSE_NEEDED=${DEFENSE_NEEDED}, PRICE_MULTIPLIER=${PRICE_MULTIPLIER}`);


// Parse the service account from environment variable
const serviceAccount = {
  type: "service_account",
  projectId: process.env.FIREBASE_PROJECT_ID,
  privateKeyId: process.env.FIREBASE_PRIVATE_KEY_ID,
  privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  clientId: process.env.FIREBASE_CLIENT_ID,
  authUri: process.env.FIREBASE_AUTH_URI,
  tokenUri: process.env.FIREBASE_TOKEN_URI,
  authProviderX509CertUrl:
    process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
  clientX509CertUrl:
    process.env.FIREBASE_CLIENT_X509_CERT_URL,
  universeDomain: process.env.FIREBASE_UNIVERSE_DOMAIN,
};

try {
  // Initialize Firebase Admin
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://solanatradingboxes-default-rtdb.firebaseio.com/",
  });

  console.log("✅ Firebase initialized");
} catch (e) {
  console.error("Firebase initialization failed:", e);
}
const db = admin.database();
console.log("✅ Firebase Admin initialized successfully");

const connection = new Connection(
  `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
);

// Strict limit for write operations
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 10,               // max 10 writes per minute per IP
  message: { error: 'Too many requests' }
});

// Looser limit for reads
const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests' }
});

// Health check endpoint
app.get("/", (req, res) => {
  res.json({
    status: "Server is running!",
    timestamp: new Date().toISOString()
  });
});

// Get all boxes
app.get("/getBoxes", async (req, res) => {

  try {
    const snapshot = await db.ref("boxes").once("value");
    res.json(snapshot.val() || {});
  } catch (error) {
    console.error("Error getting boxes:", error);
    res.status(500).json({ error: error.message });
  }
});

// Update a single box
app.post("/updateBox", writeLimiter, async (req, res) => {
  const { boxNumber, boxData, swapSignature, paymentSignature, buyerWallet } = req.body;

  if (!boxNumber || !boxData || !swapSignature || !buyerWallet) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    // Verify the swap transaction actually happened on-chain
    const tx = await connection.getTransaction(swapSignature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });

    if (!tx) {
      return res.status(400).json({ error: "Transaction not found on chain" });
    }

    // Check it's not too old (within last 5 minutes)
    const txTime = tx.blockTime * 1000;
    if (Date.now() - txTime > 5 * 60 * 1000) {
      return res.status(400).json({ error: "Transaction too old" });
    }

    // Check the declared buyer matches the tx fee payer
    const feePayer = tx.transaction.message.staticAccountKeys[0].toString();
    if (feePayer !== buyerWallet) {
      return res.status(403).json({ error: "Buyer wallet mismatch" });
    }

    // Now safe to update
    await db.ref(`boxes/${boxNumber}`).set(boxData);
    res.json({ success: true });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save a transaction
app.post("/saveTransaction", writeLimiter, async (req, res) => {
  try {
    const { boxNumber, transactionId, data } = req.body;

    if (!boxNumber || !transactionId || !data) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    await db.ref(`transactions/${boxNumber}/${transactionId}`).set(data);
    console.log(`✅ Transaction saved for box ${boxNumber}`);
    res.json({ success: true });
  } catch (error) {
    console.error("Error saving transaction:", error);
    res.status(500).json({ error: error.message });
  }
});

// Save defense points
app.post("/saveDefense", writeLimiter, async (req, res) => {
  const { wallet, boxNumber, points } = req.body;

  if (!wallet || !boxNumber || points === undefined) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    // Verify wallet actually owns this box
    const boxSnapshot = await db.ref(`boxes/${boxNumber}`).once("value");
    const box = boxSnapshot.val();

    if (!box || box.owner !== wallet) {
      return res.status(403).json({ error: "Wallet does not own this box" });
    }

    const validPoints = Math.min(5, Math.max(0, points));
    await db.ref(`defenses/${wallet}/${boxNumber}`).set(validPoints);
    res.json({ success: true });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all defense points for wallet
app.get("/getDefenses/:wallet", async (req, res) => {
  try {
    const { wallet } = req.params;

    const snapshot = await db.ref(`defenses/${wallet}`).once("value");

    res.json(snapshot.val() || {});
  } catch (error) {
    console.error("Error getting defenses:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get defense points for a wallet
app.get("/getDefense/:wallet/:boxNumber", readLimiter, async (req, res) => {
  try {
    const { wallet, boxNumber } = req.params;
    const snapshot = await db.ref(`defenses/${wallet}/${boxNumber}`).once("value");
    res.json({ points: snapshot.val() || 0 });
  } catch (error) {
    console.error("Error getting defense points:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get RPC URL
app.use('/rpc', createProxyMiddleware({
  target: 'https://mainnet.helius-rpc.com',
  changeOrigin: true,

  pathRewrite: {
    '^/rpc': '/',
  },

  onProxyReq: (proxyReq, req, res) => {
    proxyReq.path += `?api-key=${process.env.HELIUS_API_KEY}`;
  }
}));


function getHighestGreenBoxPrice(boxesData) {
  let highestPrice = 0.001;

  for (const key in boxesData) {
    const box = boxesData[key];

    if (
      box.isTrading &&
      !box.isChampion &&
      box.currentPrice > highestPrice
    ) {
      highestPrice = box.currentPrice;
    }
  }

  return highestPrice;
}

function getNextChampionPrice(currentPrice) {
  let newPrice = currentPrice * PRICE_MULTIPLIER;

  if (newPrice >= CHAMPION_MAX_PRICE) {
    newPrice = CHAMPION_MAX_PRICE;
  }

  return newPrice;
}

// ---- NEW: shared helpers for the admin dashboard ----
// These derive dashboard-facing concepts (status / underAttack) from the
// fields that actually exist on a box today. There is no explicit
// "available" flag in the trading model, so it's inferred as:
//   unsold    -> box has never been purchased (!isSold)
//   available -> owned, but still below the max price cap, i.e. it can
//                still be taken over by a higher bidder
//   sold      -> owned AND at/above its max price cap (final owner)
// "under attack" is inferred from `locked`, i.e. someone currently has an
// in-flight purchase/takeover attempt against this box.
// Adjust this mapping if your intended game semantics differ.
function getMaxAllowedPrice(box) {
  return box && box.isChampion ? CHAMPION_MAX_PRICE : MAX_PRICE;
}
 
function getBoxStatus(box) {
  if (!box || !box.isSold) return 'unsold';
  return box.currentPrice >= getMaxAllowedPrice(box) ? 'sold' : 'available';
}
 
function isUnderAttack(box) {
  return !!(box && box.locked);
}
 
function toDashboardBox(boxNumber, box) {
  box = box || {};
  return {
    boxNumber,
    status: getBoxStatus(box),
    underAttack: isUnderAttack(box),
    owner: box.owner || null,
    currentPrice: box.currentPrice ?? null,
    purchaseCount: box.purchaseCount || 0,
    attackCount: box.attackCount || 0,
    isChampion: !!box.isChampion,
    lastAcquiredAt: box.lastPurchaseTime || null,
  };
}

async function checkAndUpdateDefensePoints() {
  console.log("🕐 Running defense cron job...");

  try {
    const snapshot = await db.ref("boxes").once("value");
    const boxesData = snapshot.val() || {};

    let updatesMade = false;

    for (const boxNumber in boxesData) {
      const box = boxesData[boxNumber];

      // Skip invalid boxes
      if (
        !box.isSold ||
        !box.isTrading ||
        box.isChampion ||
        !box.owner ||
        !box.lastPurchaseTime
      ) {
        continue;
      }

      const currentTime = Date.now();

      const holdDurationMs =
        currentTime - box.lastPurchaseTime;

      const holdDurationHours =
        holdDurationMs / (1000 * 60 * 60);

      const earnedDefenses =
        Math.floor(holdDurationHours / DEFENSE_HOURS);

      if (earnedDefenses <= 0) {
        continue;
      }

      // Load current defense points
      const defenseSnapshot = await db
        .ref(`defenses/${box.owner}/${boxNumber}`)
        .once("value");

      const currentPoints = defenseSnapshot.val() || 0;

      // Already up-to-date
      if (earnedDefenses <= currentPoints) {
        continue;
      }

      const newPoints = Math.min(
        DEFENSE_NEEDED,
        earnedDefenses
      );

      // Save new defense points
      await db
        .ref(`defenses/${box.owner}/${boxNumber}`)
        .set(newPoints);

      console.log(
        `🏆 ${box.owner} earned defense on box #${boxNumber}: ${currentPoints} → ${newPoints}`
      );

      updatesMade = true;

      // Upgrade to Champion
      if (
        newPoints >= DEFENSE_NEEDED &&
        !box.isChampion
      ) {
        box.isChampion = true;

        const highestPrice =
          getHighestGreenBoxPrice(boxesData);

        const calculatedPrice =
          box.currentPrice + (highestPrice * 1.1);

        const championStartPrice =
          Math.max(0.1, calculatedPrice);

        if (championStartPrice >= CHAMPION_MAX_PRICE) {
          box.currentPrice = CHAMPION_MAX_PRICE;
        } else {
          box.currentPrice = championStartPrice;
        }

        box.nextPrice =
          getNextChampionPrice(box.currentPrice);

        await db
          .ref(`boxes/${boxNumber}`)
          .set(box);

        console.log(
          `👑 BOX #${boxNumber} became a CHAMPION BOX`
        );
      }
    }

    if (updatesMade) {
      console.log("✅ Defense updates completed");
    } else {
      console.log("ℹ️ No defense updates needed");
    }

  } catch (error) {
    console.error(
      "❌ Defense cron job error:",
      error
    );
  }
}
async function refundBuyer(
  buyerWallet,
  amountLamports
) {

  const refundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: escrowKeypair.publicKey,
      toPubkey: new PublicKey(buyerWallet),
      lamports: amountLamports
    })
  );

  const sig =
    await connection.sendTransaction(
      refundTx,
      [escrowKeypair]
    );

  await connection.confirmTransaction(
    sig,
    "confirmed"
  );

  return sig;
}
app.post("/getPaymentInfo", async (req, res) => {
  try {
    res.json({
      creatorWallet: CREATOR_WALLET
    });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

app.post("/createPurchase", async (req, res) => {
  try {
    const { boxNumber, buyerWallet } = req.body;
    if (!boxNumber || !buyerWallet) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const snapshot = await db.ref(`boxes/${boxNumber}`).once("value");
    const box = snapshot.val();

    // REJECT IF BOX IS ALREADY LOCKED
    if (box && box.locked) {

      if (
        box.lockExpiry &&
        Date.now() > box.lockExpiry
      ) {
        await db.ref(`boxes/${boxNumber}`).update({
          locked: false,
          pendingPurchaseId: null,
          lockExpiry: null
        });
      } else {
        return res.status(409).json({
          error: "Box is currently being purchased. Try again shortly."
        });
      }
    }

    let currentPrice = STARTING_PRICE;
    if (box && (box.isTrading || box.isSold)) {
      currentPrice = box.currentPrice;
    }

    const maxAllowed = box?.isChampion ? CHAMPION_MAX_PRICE : MAX_PRICE;
    if (box && box.currentPrice >= maxAllowed && box.purchaseCount > 0) {
      return res.status(400).json({ error: "Box reached max price" });
    }


    const purchaseId = crypto.randomUUID();
    const now = Date.now();
    const purchaseData = {
      purchaseId,
      boxNumber,
      buyerWallet,
      createdAt: now,
      expiresAt: now + (5 * 60 * 1000),
      expectedPrice: currentPrice,
      totalExpected: currentPrice,
      sellerWallet: box?.owner || null,
      isChampion: box?.isChampion || false
    };

    // ATOMIC: create pending purchase + lock box
    await db.ref(`pendingPurchases/${purchaseId}`).set(purchaseData);
    await db.ref(`boxes/${boxNumber}`).update({
      locked: true,
      lockedAt: now,
      lockExpiry: now + (5 * 60 * 1000),
      pendingPurchaseId: purchaseId
    });

    res.json(purchaseData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/refundPurchase", async (req, res) => {
  try {
    const { purchaseId, paymentSignature } = req.body;
    if (!purchaseId || !paymentSignature) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const purchaseSnap = await db.ref(`pendingPurchases/${purchaseId}`).once("value");
    const purchase = purchaseSnap.val();
    if (!purchase) {
      return res.status(404).json({ error: "Purchase not found or already finalized" });
    }

    // Verify payment tx exists and buyer sent to escrow
    const paymentTx = await connection.getTransaction(paymentSignature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });
    if (!paymentTx) {
      return res.status(400).json({ error: "Payment tx not found on chain" });
    }

    const feePayer = paymentTx.transaction.message.staticAccountKeys[0].toString();
    if (feePayer !== purchase.buyerWallet) {
      return res.status(403).json({ error: "Buyer mismatch" });
    }

    // Verify escrow received funds
    const escrowAddress = process.env.ESCROW_PUBLIC_KEY;
    const keys = paymentTx.transaction.message.staticAccountKeys;
    const preBalances = paymentTx.meta.preBalances;
    const postBalances = paymentTx.meta.postBalances;
    const totalLamports = Math.floor(
      purchase.totalExpected * 1_000_000_000
    );

    let escrowPaid = false;
    for (let i = 0; i < keys.length; i++) {
      if (keys[i].toString() === escrowAddress && (postBalances[i] - preBalances[i]) >= totalLamports) {
        escrowPaid = true;
        break;
      }
    }
    if (!escrowPaid) {
      return res.status(400).json({ error: "Escrow payment not verified" });
    }

    // REFUND from escrow back to buyer
    const refundSig = await refundBuyer(purchase.buyerWallet, totalLamports);

    // UNLOCK box and cleanup
    await db.ref(`boxes/${purchase.boxNumber}`).update({
      locked: false,
      pendingPurchaseId: null,
      lockExpiry: null
    });
    await db.ref(`pendingPurchases/${purchaseId}`).remove();

    res.json({ success: true, refunded: true, refundSignature: refundSig });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/confirmPurchase", async (req, res) => {
  let purchase = null;
  let escrowVerified = false;
  let paymentAlreadyRefunded = false;
  let paymentSignature = null;
  let transferSignature = null;

  try {

    const { purchaseId, paymentSignature: _paymentSignature } = req.body;
    paymentSignature = _paymentSignature;

    // -----------------------------
    // VALIDATION
    // -----------------------------
    if (!purchaseId || !paymentSignature) {
      return res.status(400).json({
        error: "Missing fields"
      });
    }

    // -----------------------------
    // LOAD PURCHASE
    // -----------------------------
    const purchaseRef =
      db.ref(`pendingPurchases/${purchaseId}`);

    const purchaseSnap =
      await purchaseRef.once("value");

    purchase = purchaseSnap.val();

    if (!purchase) {
      return res.status(404).json({
        error: "Purchase not found"
      });
    }

    // -----------------------------
    // EXPIRED
    // -----------------------------
    if (Date.now() > purchase.expiresAt) {

      // unlock box
      await db.ref(`boxes/${purchase.boxNumber}`).update({
        locked: false,
        pendingPurchaseId: null,
        lockExpiry: null
      });

      await purchaseRef.remove();

      return res.status(400).json({
        error: "Purchase expired"
      });
    }

    // -----------------------------
    // IDEMPOTENCY CHECK
    // -----------------------------
    if (purchase.status === "completed") {
      return res.json({
        success: true,
        alreadyProcessed: true
      });
    }

    if (purchase.processing === true) {
      return res.status(409).json({
        error: "Purchase already processing"
      });
    }

    // -----------------------------
    // LOCK PROCESSING
    // -----------------------------
    await purchaseRef.update({
      processing: true,
      status: "verifying_payment"
    });

    // -----------------------------
    // REPLAY PROTECTION
    // -----------------------------
    const sigRef =
      db.ref(`usedSignatures/${paymentSignature}`);

    const sigSnap =
      await sigRef.once("value");

    if (sigSnap.exists()) {

      await purchaseRef.update({
        processing: false,
        status: "failed"
      });

      return res.status(400).json({
        error: "Payment signature already used"
      });
    }

    // -----------------------------
    // VERIFY PAYMENT TX
    // -----------------------------
    const paymentTx =
      await connection.getTransaction(
        paymentSignature,
        {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0
        }
      );

    if (!paymentTx) {

      await purchaseRef.update({
        processing: false,
        status: "failed"
      });

      return res.status(400).json({
        error: "Payment tx not found"
      });
    }

    // -----------------------------
    // VERIFY BUYER
    // -----------------------------
    const feePayer =
      paymentTx.transaction.message.staticAccountKeys[0].toString();

    if (feePayer !== purchase.buyerWallet) {

      await purchaseRef.update({
        processing: false,
        status: "failed"
      });

      return res.status(403).json({
        error: "Invalid payment sender"
      });
    }


    // -----------------------------
    // GET BOX
    // -----------------------------
    const boxRef =
      db.ref(`boxes/${purchase.boxNumber}`);

    const boxSnap =
      await boxRef.once("value");

    const box =
      boxSnap.val() || {};

    const oldOwner =
      box.owner || null;
    const isFirstPurchase =
      !oldOwner;

    const boxLamports =
      Math.floor(
        purchase.expectedPrice * 1_000_000_000
      );


    // -----------------------------
    // VERIFY ESCROW RECEIVED SOL
    // -----------------------------
    const escrowAddress =
      process.env.ESCROW_PUBLIC_KEY;

    const totalExpectedLamports =
      boxLamports;
    const keys =
      paymentTx.transaction.message.staticAccountKeys;
    const preBalances =
      paymentTx.meta.preBalances;
    const postBalances =
      paymentTx.meta.postBalances;

    let escrowReceived = false;

    for (let i = 0; i < keys.length; i++) {

      const addr = keys[i].toString();

      const diff =
        postBalances[i] - preBalances[i];

      if (
        addr === escrowAddress &&
        diff >= totalExpectedLamports
      ) {
        escrowReceived = true;
        break;
      }
    }

    if (!escrowReceived) {

      await purchaseRef.update({
        processing: false,
        status: "failed"
      });

      return res.status(400).json({
        error: "Escrow payment missing"
      });
    }

    escrowVerified = true;
    // -----------------------------
    // SAVE USED SIGNATURE
    // -----------------------------
    await sigRef.set({
      usedAt: Date.now(),
      purchaseId
    });

    // -----------------------------
    // UPDATE STATUS
    // -----------------------------
    await purchaseRef.update({
      status: "swapping"
    });



    let rewardLamports;

    if (isFirstPurchase) {
      rewardLamports =
        Math.floor(boxLamports * 0.10);
    } else {

      const previousInvestment =
        box.ownerInvestment ||
        STARTING_PRICE;

      const sellerLamports =
        Math.floor(
          previousInvestment *
          1.10 *
          1_000_000_000
        );

      const profitLamports =
        boxLamports -
        sellerLamports;

      rewardLamports =
        Math.floor(
          profitLamports * 0.10
        );
    }

    const swapLamports = rewardLamports;

    // -----------------------------
    // GET TOKEN BALANCE BEFORE SWAP
    // -----------------------------
    const escrowBoxAta =
      await getAssociatedTokenAddress(
        new PublicKey(process.env.BOX_MINT),
        escrowKeypair.publicKey
      );

    let beforeAmount = BigInt(0);

    try {

      const beforeAccount =
        await getAccount(
          connection,
          escrowBoxAta
        );

      beforeAmount =
        beforeAccount.amount;

    } catch { }


    // -----------------------------
    // JUPITER V2 ORDER
    // -----------------------------
    const orderUrl =
      `https://api.jup.ag/swap/v2/order` +
      `?inputMint=${process.env.SOL_MINT}` +
      `&outputMint=${process.env.BOX_MINT}` +
      `&amount=${swapLamports}` +
      `&taker=${escrowKeypair.publicKey.toString()}`;

    const orderRes = await fetch(orderUrl);

    if (!orderRes.ok) {

      const errText = await orderRes.text();

      await purchaseRef.update({
        processing: false,
        status: "failed"
      });

      return res.status(500).json({
        error: `Order API Error: ${errText}`
      });
    }

    const orderData = await orderRes.json();

    console.log("ORDER DATA:", orderData);

    if (!orderData.transaction) {
      // Unlock the box immediately
      await db.ref(`boxes/${purchase.boxNumber}`).update({
        locked: false,
        pendingPurchaseId: null,
        lockExpiry: null
      });
      await purchaseRef.update({ processing: false, status: "failed" });

      return res.status(500).json({
        error: `Jupiter returned no transaction: ${JSON.stringify(orderData)}`
      });
    }

    if (!orderData.requestId) {

      await purchaseRef.update({
        processing: false,
        status: "failed"
      });

      return res.status(500).json({
        error: "No requestId returned from Jupiter"
      });
    }

    // -----------------------------
    // DESERIALIZE TX
    // -----------------------------
    const txBuffer = Buffer.from(
      orderData.transaction,
      "base64"
    );

    const transaction =
      VersionedTransaction.deserialize(
        txBuffer
      );

    // -----------------------------
    // SIGN TX
    // -----------------------------
    transaction.sign([
      escrowKeypair
    ]);

    // -----------------------------
    // EXECUTE SWAP
    // -----------------------------
    const signedTransactionBase64 =
      Buffer.from(
        transaction.serialize()
      ).toString("base64");

    const executeRes = await fetch(
      "https://api.jup.ag/swap/v2/execute",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          signedTransaction:
            signedTransactionBase64,

          requestId:
            orderData.requestId
        })
      }
    );

    if (!executeRes.ok) {

      const errText = await executeRes.text();

      await purchaseRef.update({
        processing: false,
        status: "failed"
      });

      return res.status(500).json({
        error: `Execute API 2 Error: ${errText}`
      });
    }

    const executeData =
      await executeRes.json();

    console.log(
      "EXECUTE DATA:",
      executeData
    );

    if (!executeData.signature) {

      await purchaseRef.update({
        processing: false,
        status: "failed"
      });

      return res.status(500).json({
        error: "No swap signature returned"
      });
    }

    const swapSignature =
      executeData.signature;

    // -----------------------------
    // CONFIRM SWAP
    // -----------------------------
    await connection.confirmTransaction(
      swapSignature,
      "confirmed"
    );

    // -----------------------------
    // CHECK TOKEN RECEIVED
    // -----------------------------
    const receivedAmount =
      BigInt(executeData.totalOutputAmount);

    console.log(
      "Received from Jupiter:",
      receivedAmount.toString()
    );

    if (receivedAmount <= 0n) {

      await purchaseRef.update({
        processing: false,
        status: "failed"
      });

      return res.status(500).json({
        error: "No BOX received from swap"
      });
    }

    // -----------------------------
    // UPDATE STATUS
    // -----------------------------
    await purchaseRef.update({
      status: "transferring_tokens"
    });

    // -----------------------------
    // BUYER ATA
    // -----------------------------
    try {

      const buyerPubkey = new PublicKey(
        purchase.buyerWallet
      );

      const mint = new PublicKey(
        process.env.BOX_MINT
      );

      const buyerAta = await getAssociatedTokenAddress(
        mint,
        buyerPubkey
      );

      const transferTx = new Transaction();

      // Create ATA if it doesn't exist
      const buyerAtaInfo =
        await connection.getAccountInfo(buyerAta);

      if (!buyerAtaInfo) {

        console.log("Buyer ATA doesn't exist. Creating...");

        transferTx.add(
          createAssociatedTokenAccountInstruction(
            escrowKeypair.publicKey, // payer
            buyerAta,
            buyerPubkey,
            mint
          )
        );
      }

      // Transfer BOX tokens
      transferTx.add(
        createTransferInstruction(
          escrowBoxAta,
          buyerAta,
          escrowKeypair.publicKey,
          receivedAmount
        )
      );

      transferSignature = await connection.sendTransaction(
        transferTx,
        [escrowKeypair]
      );

      await connection.confirmTransaction(
        transferSignature,
        "confirmed"
      );

      console.log(
        "✅ BOX transfer completed:",
        transferSignature
      );

      // -----------------------------
      // UPDATE STATUS
      // -----------------------------
      await purchaseRef.update({
        status: "paying_out"
      });

    } catch (transferError) {

      console.error(
        "❌ BOX transfer failed:",
        transferError
      );

      // Let outer catch refund buyer
      throw new Error(
        `BOX transfer failed: ${transferError.message}`
      );
    }
    // -----------------------------
    // PAYOUT
    // -----------------------------

    let payoutSignature = null;

    const TREASURY_WALLET =
      process.env.TREASURY_WALLET;

    const PLATFORM_WALLET =
      process.env.CREATOR_WALLET;

    const payoutTx =
      new Transaction();

    if (isFirstPurchase) {

      const platformLamports =
        Math.floor(boxLamports * 0.10);

      const treasuryLamports =
        Math.floor(boxLamports * 0.80);

      const boxTokenLamports =
        Math.floor(boxLamports * 0.10);
      // payoutTx.add(
      //   SystemProgram.transfer({
      //     fromPubkey: escrowKeypair.publicKey,
      //     toPubkey: new PublicKey(PLATFORM_WALLET),
      //     lamports: platformLamports
      //   })
      // );

      // payoutTx.add(
      //   SystemProgram.transfer({
      //     fromPubkey: escrowKeypair.publicKey,
      //     toPubkey: new PublicKey(TREASURY_WALLET),
      //     lamports: treasuryLamports
      //   })
      // );

    } else if (
      oldOwner !== purchase.buyerWallet
    ) {

      const previousInvestment =
        box.ownerInvestment ||
        STARTING_PRICE;

      const sellerPayoutSOL =
        previousInvestment * 1.10;

      const sellerLamports =
        Math.floor(
          sellerPayoutSOL *
          1_000_000_000
        );

      const profitLamports =
        boxLamports - sellerLamports;

      const boxTokenLamports =
        Math.floor(profitLamports * 0.10);

      const platformLamports =
        Math.floor(profitLamports * 0.10);

      const treasuryLamports =
        profitLamports -
        rewardLamports -
        platformLamports;

      payoutTx.add(
        SystemProgram.transfer({
          fromPubkey: escrowKeypair.publicKey,
          toPubkey: new PublicKey(oldOwner),
          lamports: sellerLamports
        })
      );

      // payoutTx.add(
      //   SystemProgram.transfer({
      //     fromPubkey: escrowKeypair.publicKey,
      //     toPubkey: new PublicKey(PLATFORM_WALLET),
      //     lamports: platformLamports
      //   })
      // );

      // payoutTx.add(
      //   SystemProgram.transfer({
      //     fromPubkey: escrowKeypair.publicKey,
      //     toPubkey: new PublicKey(TREASURY_WALLET),
      //     lamports: treasuryLamports
      //   })
      // );
    }

    if (payoutTx.instructions.length > 0) {

      payoutSignature =
        await connection.sendTransaction(
          payoutTx,
          [escrowKeypair]
        );

      await connection.confirmTransaction(
        payoutSignature,
        "confirmed"
      );
    }

    // // PAY PLATFORM
    // payoutTx.add(
    //   SystemProgram.transfer({
    //     fromPubkey:
    //       escrowKeypair.publicKey,

    //     toPubkey:
    //       new PublicKey(
    //         process.env.CREATOR_WALLET
    //       ),

    //     lamports:
    //       creatorLamports
    //   })
    // );


    // -----------------------------
    // PRICE CALCULATION
    // -----------------------------
    const paidPrice =
      purchase.expectedPrice;

    let nextPrice =
      paidPrice * PRICE_MULTIPLIER;

    if (box.isChampion) {
      nextPrice =
        Math.min(
          nextPrice,
          CHAMPION_MAX_PRICE
        );
    } else {
      nextPrice =
        Math.min(
          nextPrice,
          MAX_PRICE
        );
    }

    // -----------------------------
    // UPDATE BOX
    // -----------------------------
    await boxRef.transaction(
      currentBox => {

        if (!currentBox) {
          currentBox = {};
        }

        currentBox.owner =
          purchase.buyerWallet;

        currentBox.previousOwner =
          oldOwner;

        currentBox.ownerInvestment = paidPrice;   // what THIS buyer paid (used for seller payout later)
        currentBox.currentPrice = nextPrice;       // ← what NEXT buyer will pay
        currentBox.nextPrice = Math.min(          // ← price after that
          nextPrice * PRICE_MULTIPLIER,
          box.isChampion ? CHAMPION_MAX_PRICE : MAX_PRICE
        );

        currentBox.purchaseCount =
          (currentBox.purchaseCount || 0) + 1;

        currentBox.isSold = true;
        currentBox.isTrading = true;

        currentBox.lastPurchaseTime =
          Date.now();

        currentBox.locked = false;
        currentBox.pendingPurchaseId = null;
        currentBox.lockExpiry = null;

        return currentBox;
      }
    );

    // -----------------------------
    // SAVE TX HISTORY
    // -----------------------------
    const txId =
      crypto.randomUUID();

    await db.ref(
      `transactions/${purchase.boxNumber}/${txId}`
    ).set({

      buyer:
        purchase.buyerWallet,

      seller:
        oldOwner,

      price:
        paidPrice,

      paymentSignature,

      swapSignature,

      transferSignature,

      payoutSignature,

      timestamp:
        Date.now()
    });

    // -----------------------------
    // COMPLETE PURCHASE
    // -----------------------------
    await purchaseRef.update({
      processing: false,
      status: "completed",
      completedAt: Date.now()
    });

    // -----------------------------
    // CLEANUP
    // -----------------------------
    await purchaseRef.remove();

    // -----------------------------
    // SHOULD STOP
    // -----------------------------
    const shouldStop =
      box.isChampion
        ? nextPrice >= CHAMPION_MAX_PRICE
        : nextPrice >= MAX_PRICE;

    // -----------------------------
    // SUCCESS
    // -----------------------------
    return res.json({
      success: true,
      newPrice:
        nextPrice,
      shouldStop,
      paymentSignature,
      swapSignature,
      transferSignature,
      payoutSignature
    });

  } catch (error) {

    console.error(
      "confirmPurchase error:",
      error
    );

    // =====================================
    // AUTO REFUND ON FAILURE
    // =====================================

    if (
      escrowVerified &&
      purchase &&
      !paymentAlreadyRefunded
    ) {

      try {

        const refundLamports =
          Math.floor(
            purchase.totalExpected *
            1_000_000_000
          );

        const refundSig =
          await refundBuyer(
            purchase.buyerWallet,
            refundLamports
          );

        console.log(
          "✅ Refund completed:",
          refundSig
        );

        paymentAlreadyRefunded = true;
        await db.ref(
          `usedSignatures/${paymentSignature}`
        ).remove();
        // unlock box
        await db.ref(
          `boxes/${purchase.boxNumber}`
        ).update({
          locked: false,
          pendingPurchaseId: null,
          lockExpiry: null
        });

        // remove pending purchase
        await db.ref(
          `pendingPurchases/${purchase.purchaseId}`
        ).remove();

      } catch (refundErr) {

        console.error(
          "❌ Refund failed:",
          refundErr
        );

        const refundLamports =
          Math.floor(
            purchase.totalExpected *
            1_000_000_000
          );

        await db.ref(
          `failedRefunds/${purchase.purchaseId}`
        ).set({
          purchaseId: purchase.purchaseId,
          wallet: purchase.buyerWallet,
          amountLamports: refundLamports,
          paymentSignature,
          reason: refundErr.message,
          createdAt: Date.now(),
          retryCount: 0
        });
      }
    }

    return res.status(500).json({
      error: error.message
    });
  }
});

// serve config constants
app.get("/getConfig", readLimiter, (req, res) => {
  const origin = req.headers.origin;
  if (origin && (origin.includes('localhost') || origin.includes('127.0.0.1'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  res.json({
    startingPrice: parseFloat(process.env.STARTING_PRICE) || 0.001,
    maxPrice: parseFloat(process.env.MAX_PRICE) || 1,
    championMaxPrice: parseFloat(process.env.CHAMPION_MAX_PRICE) || 2,
    priceMultiplier: parseFloat(process.env.PRICE_MULTIPLIER) || 1.4,
    defenseHours: parseInt(process.env.DEFENSE_HOURS) || 0.0083,
    defenseNeeded: parseInt(process.env.DEFENSE_NEEDED) || 5,
    slippageBps: parseInt(process.env.SLIPPAGE_BPS) || 50,
    gridSize: 100,
  });
});
app.get("/getRpcConfig", (req, res) => {
  res.json({
    rpc: `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,
    ws: `wss://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
  });
});

// return Jupiter swap params (hides BOX_MINT from HTML)
app.post("/getSwapParams", writeLimiter, async (req, res) => {
  try {
    const { boxNumber, buyerWallet } = req.body;
    if (!boxNumber || !buyerWallet) return res.status(400).json({ error: "Missing fields" });

    const snapshot = await db.ref(`boxes/${boxNumber}`).once("value");
    const box = snapshot.val() || {};
    const maxAllowed = box.isChampion ? CHAMPION_MAX_PRICE : MAX_PRICE;

    if (box.currentPrice >= maxAllowed && box.purchaseCount > 0)
      return res.status(400).json({ error: "Box reached max price" });

    const currentPrice = (box.isTrading || box.isSold) ? box.currentPrice : 0.001;

    res.json({
      inputMint: process.env.SOL_MINT || "So11111111111111111111111111111111111111112",
      outputMint: process.env.BOX_MINT,
      amountLamports: Math.floor(currentPrice * 1_000_000_000),
      slippageBps: parseInt(process.env.SLIPPAGE_BPS) || 50,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

//  build payment tx server-side (hides CREATOR_WALLET + split logic)
app.post("/buildPaymentTx", writeLimiter, async (req, res) => {
  try {

    const { purchaseId, buyerWallet } = req.body;

    if (!purchaseId || !buyerWallet) {
      return res.status(400).json({
        error: "Missing fields"
      });
    }

    const snap =
      await db.ref(
        `pendingPurchases/${purchaseId}`
      ).once("value");

    const purchase = snap.val();

    if (!purchase) {
      return res.status(404).json({
        error: "Purchase not found"
      });
    }

    if (Date.now() > purchase.expiresAt) {
      return res.status(400).json({
        error: "Expired"
      });
    }

    if (purchase.buyerWallet !== buyerWallet) {
      return res.status(403).json({
        error: "Wallet mismatch"
      });
    }

    // =====================================
    // BOX PRICE
    // =====================================

    const boxPrice =
      Number(purchase.expectedPrice);

    // =====================================
    // TOTAL USER PAYS
    // =====================================

    const totalAmount = boxPrice;

    const lamports =
      Math.floor(
        totalAmount * 1_000_000_000
      );

    // =====================================
    // BUILD TX
    // =====================================

    const { blockhash } =
      await connection.getLatestBlockhash();

    const tx = new Transaction();

    tx.add(
      SystemProgram.transfer({
        fromPubkey:
          new PublicKey(buyerWallet),

        toPubkey:
          new PublicKey(
            process.env.ESCROW_PUBLIC_KEY
          ),

        lamports
      })
    );

    tx.feePayer =
      new PublicKey(buyerWallet);

    tx.recentBlockhash =
      blockhash;

    // =====================================
    // SERIALIZE
    // =====================================

    const serialized =
      tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false
      });

    // =====================================
    // RESPONSE
    // =====================================

    res.json({

      transaction:
        Buffer.from(serialized)
          .toString("base64"),

      feeBreakdown: {

        boxPrice:
          boxPrice.toFixed(4),

        total:
          totalAmount.toFixed(4)
      }
    });

  } catch (e) {

    console.error(e);

    res.status(500).json({
      error: e.message
    });
  }
});

async function cleanupExpiredLocks() {
  const now = Date.now();
  const boxesSnap = await db.ref("boxes").once("value");
  const boxes = boxesSnap.val() || {};

  for (const [boxNumber, box] of Object.entries(boxes)) {
    if (box.locked && box.lockExpiry && now > box.lockExpiry) {
      await db.ref(`boxes/${boxNumber}`).update({
        locked: false,
        pendingPurchaseId: null,
        lockExpiry: null
      });
      if (box.pendingPurchaseId) {
        await db.ref(`pendingPurchases/${box.pendingPurchaseId}`).remove();
      }
      console.log(`🔓 Auto-unlocked expired box #${boxNumber}`);
    }
  }
}

app.post("/ensureAta", async (req, res) => {
  try {

    const { walletAddress } = req.body;

    if (!walletAddress) {
      return res.status(400).json({
        success: false,
        error: "walletAddress required"
      });
    }

    const connection = new Connection(
      `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    );

    const mint = new PublicKey(
      process.env.BOX_MINT
    );

    const owner = new PublicKey(
      walletAddress
    );

    const ata =
      await getAssociatedTokenAddress(
        mint,
        owner
      );

    const ataInfo =
      await connection.getAccountInfo(ata);

    if (ataInfo) {
      return res.json({
        success: true,
        ataExists: true,
        ata: ata.toBase58()
      });
    }

    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        owner, // payer
        ata,
        owner,
        mint
      )
    );

    const serialized = tx
      .serialize({
        requireAllSignatures: false
      })
      .toString("base64");

    res.json({
      success: true,
      ataExists: false,
      ata: ata.toBase58(),
      transaction: serialized
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.post("/cancelPurchase", async (req, res) => {
  const { purchaseId, boxNumber } = req.body;

  await db.ref(`boxes/${boxNumber}`).update({
    locked: false,
    pendingPurchaseId: null,
    lockExpiry: null
  });

  await db.ref(`pendingPurchases/${purchaseId}`).remove();

  res.json({ success: true });
});

async function processFailedRefunds() {

  try {

    const snap =
      await db.ref("failedRefunds").once("value");

    const refunds =
      snap.val() || {};

    for (const purchaseId of Object.keys(refunds)) {

      const refund =
        refunds[purchaseId];

      try {

        const refundSig =
          await refundBuyer(
            refund.wallet,
            refund.amountLamports
          );

        console.log(
          `✅ Retry refund success: ${purchaseId}`
        );

        await db.ref(
          `failedRefunds/${purchaseId}`
        ).remove();

        await db.ref(
          `refundHistory/${purchaseId}`
        ).set({
          ...refund,
          refundSignature: refundSig,
          refundedAt: Date.now()
        });

      } catch (err) {

        console.error(
          `❌ Retry refund failed: ${purchaseId}`,
          err.message
        );

        await db.ref(
          `failedRefunds/${purchaseId}`
        ).update({
          retryCount:
            (refund.retryCount || 0) + 1,
          lastError:
            err.message,
          lastAttempt:
            Date.now()
        });
      }
    }

  } catch (err) {

    console.error(
      "Failed refund processor error:",
      err
    );
  }
}


 
/* ============================================================================
   ============================================================================
   NEW: ADMIN DASHBOARD API — backs the "Box Console" index.html
   Mounted under /api to match the dashboard's API_BASE.
   Uses the same Firebase Realtime Database instance (db) as the rest of
   this file. Admin users live in a separate `adminUsers` node — they are
   NOT wallet-based, they're username/password operators of the dashboard.
   ============================================================================
   ============================================================================ */
 
const adminApi = express.Router();
app.use("/api", adminApi);
 
// ---- auth helpers ----
function signAdminToken(user) {
  return jwt.sign(
    { userId: user.id, username: user.username, role: user.role },
    ADMIN_JWT_SECRET,
    { expiresIn: ADMIN_JWT_EXPIRES_IN }
  );
}
 
function verifyAdminToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }
  const token = authHeader.split(" ")[1];
  try {
    req.adminUser = jwt.verify(token, ADMIN_JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
 
function requireFullAccess(req, res, next) {
  if (req.adminUser?.role !== "full_access") {
    return res.status(403).json({ error: "Full access permission required" });
  }
  next();
}
 
async function findAdminUserByUsername(username) {
  const snap = await db.ref("adminUsers").once("value");
  const all = snap.val() || {};
  for (const id of Object.keys(all)) {
    if (all[id].username === username) return { id, ...all[id] };
  }
  return null;
}
 
// One-time bootstrap: if no admin users exist yet, create the first
// full_access user from env vars so you're never locked out.
async function bootstrapFirstAdminUser() {
  try {
    const snap = await db.ref("adminUsers").once("value");
    if (snap.exists()) return; // already have at least one admin
 
    const username = process.env.ADMIN_BOOTSTRAP_USERNAME;
    const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
    if (!username || !password) {
      console.warn("⚠️  No adminUsers exist yet, and ADMIN_BOOTSTRAP_USERNAME/PASSWORD are not set. You will not be able to log in to the dashboard until one is created directly in Firebase.");
      return;
    }
 
    const passwordHash = await bcrypt.hash(password, 10);
    const ref = db.ref("adminUsers").push();
    await ref.set({
      username,
      passwordHash,
      role: "full_access",
      active: true,
      createdAt: Date.now(),
    });
    console.log(`✅ Bootstrapped first admin user "${username}" (full_access)`);
  } catch (err) {
    console.error("❌ Failed to bootstrap admin user:", err);
  }
}
 
// ---- POST /api/auth/login ----
adminApi.post("/auth/login", writeLimiter, async (req, res) => {
  console.log("LOGIN ROUTE HIT");
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required" });
    }
 
    const user = await findAdminUserByUsername(username);
    if (!user || !user.active) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
 
    const matches = await bcrypt.compare(password, user.passwordHash);
    if (!matches) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
 
    const token = signAdminToken(user);
    res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: err.message });
  }
});
 
// Everything below this line requires a valid admin token.
adminApi.use(verifyAdminToken);
 
// ---- GET /api/boxes/stats ----
adminApi.get("/boxes/stats", readLimiter, async (req, res) => {
  try {
    const snap = await db.ref("boxes").once("value");
    const boxesData = snap.val() || {};
 
    const totals = { total: 0, unsold: 0, available: 0, sold: 0, underAttack: 0 };
    const dashboardBoxes = [];
 
    for (const boxNumber of Object.keys(boxesData)) {
      const dBox = toDashboardBox(boxNumber, boxesData[boxNumber]);
      dashboardBoxes.push(dBox);
      totals.total += 1;
      totals[dBox.status] += 1;
      if (dBox.underAttack) totals.underAttack += 1;
    }
 
    const newestPurchases = dashboardBoxes
      .filter((b) => b.lastAcquiredAt)
      .sort((a, b) => b.lastAcquiredAt - a.lastAcquiredAt)
      .slice(0, 10);
 
    res.json({ totals, newestPurchases });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// ---- GET /api/boxes (list, with search/status/underAttack filters) ----
adminApi.get("/boxes", readLimiter, async (req, res) => {
  try {
    const { search, status, underAttack, limit } = req.query;
 
    const snap = await db.ref("boxes").once("value");
    const boxesData = snap.val() || {};
 
    let boxes = Object.keys(boxesData).map((boxNumber) => toDashboardBox(boxNumber, boxesData[boxNumber]));
 
    if (status) {
      boxes = boxes.filter((b) => b.status === status);
    }
    if (underAttack === "true" || underAttack === "false") {
      const want = underAttack === "true";
      boxes = boxes.filter((b) => b.underAttack === want);
    }
    if (search) {
      const q = search.toLowerCase();
      boxes = boxes.filter(
        (b) => String(b.boxNumber).toLowerCase().includes(q) || (b.owner && b.owner.toLowerCase().includes(q))
      );
    }
 
    boxes.sort((a, b) => Number(a.boxNumber) - Number(b.boxNumber));
 
    if (limit) {
      boxes = boxes.slice(0, parseInt(limit, 10) || boxes.length);
    }
 
    res.json({ boxes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// ---- POST /api/boxes/reward (full_access) ----
// Gifts BOX SPL tokens to a set of wallets and makes each wallet the
// registered owner of the paired Box number, exactly as if purchased.
adminApi.post("/boxes/reward", writeLimiter, requireFullAccess, async (req, res) => {
  try {
    const { walletAddresses, boxNumbers, tokenAmountPerBox } = req.body;
 
    if (!Array.isArray(walletAddresses) || !Array.isArray(boxNumbers) || walletAddresses.length === 0) {
      return res.status(400).json({ error: "walletAddresses and boxNumbers are required" });
    }
    if (walletAddresses.length !== boxNumbers.length) {
      return res.status(400).json({ error: "walletAddresses and boxNumbers must be the same length" });
    }
    const amount = Number(tokenAmountPerBox);
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "tokenAmountPerBox must be a positive number" });
    }
 
    const mint = new PublicKey(process.env.BOX_MINT);
    const escrowBoxAta = await getAssociatedTokenAddress(mint, escrowKeypair.publicKey);
    const rawAmount = BigInt(Math.round(amount * 10 ** BOX_MINT_DECIMALS));
 
    const results = [];
 
    for (let i = 0; i < walletAddresses.length; i++) {
      const wallet = walletAddresses[i];
      const boxNumber = boxNumbers[i];
 
      try {
        const buyerPubkey = new PublicKey(wallet);
        const buyerAta = await getAssociatedTokenAddress(mint, buyerPubkey);
 
        const tx = new Transaction();
        const buyerAtaInfo = await connection.getAccountInfo(buyerAta);
        if (!buyerAtaInfo) {
          tx.add(createAssociatedTokenAccountInstruction(escrowKeypair.publicKey, buyerAta, buyerPubkey, mint));
        }
        tx.add(createTransferInstruction(escrowBoxAta, buyerAta, escrowKeypair.publicKey, rawAmount));
 
        const transferSignature = await connection.sendTransaction(tx, [escrowKeypair]);
        await connection.confirmTransaction(transferSignature, "confirmed");
 
        // Register ownership in Firebase, same shape a normal purchase would leave.
        const boxRef = db.ref(`boxes/${boxNumber}`);
        const boxSnap = await boxRef.once("value");
        const existingBox = boxSnap.val() || {};
 
        await boxRef.update({
          owner: wallet,
          previousOwner: existingBox.owner || null,
          isSold: true,
          isTrading: true,
          purchaseCount: (existingBox.purchaseCount || 0) + 1,
          lastPurchaseTime: Date.now(),
          currentPrice: existingBox.currentPrice || STARTING_PRICE,
          nextPrice: existingBox.nextPrice || STARTING_PRICE * PRICE_MULTIPLIER,
        });
 
        const txId = crypto.randomUUID();
        await db.ref(`transactions/${boxNumber}/${txId}`).set({
          buyer: wallet,
          seller: existingBox.owner || null,
          type: "reward",
          tokenAmount: amount,
          transferSignature,
          rewardedBy: req.adminUser.username,
          timestamp: Date.now(),
        });
 
        results.push({ boxNumber, wallet, success: true, transferSignature });
      } catch (err) {
        results.push({ boxNumber, wallet, success: false, error: err.message });
      }
    }
 
    const failures = results.filter((r) => !r.success);
    emitBoxesUpdate();
 
    if (failures.length > 0) {
      return res.status(207).json({ success: false, results, message: `${failures.length} of ${results.length} rewards failed` });
    }
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// ---- POST /api/boxes/reset (full_access) ----
// Snapshots each box to resetHistory, then clears it back to unsold.
adminApi.post("/boxes/reset", writeLimiter, requireFullAccess, async (req, res) => {
  try {
    const { boxNumbers } = req.body;
    if (!Array.isArray(boxNumbers) || boxNumbers.length === 0) {
      return res.status(400).json({ error: "boxNumbers is required" });
    }
 
    for (const boxNumber of boxNumbers) {
      const boxRef = db.ref(`boxes/${boxNumber}`);
      const snap = await boxRef.once("value");
      const existingBox = snap.val();
 
      const historyRef = db.ref("resetHistory").push();
      await historyRef.set({
        boxNumber: String(boxNumber),
        snapshot: existingBox || null,
        resetBy: req.adminUser.username,
        resetAt: Date.now(),
        restored: false,
      });
 
      await boxRef.set({
        owner: null,
        previousOwner: existingBox?.owner || null,
        isSold: false,
        isTrading: false,
        isChampion: false,
        locked: false,
        pendingPurchaseId: null,
        lockExpiry: null,
        currentPrice: STARTING_PRICE,
        nextPrice: STARTING_PRICE * PRICE_MULTIPLIER,
        purchaseCount: 0,
        attackCount: 0,
        ownerInvestment: null,
        lastPurchaseTime: null,
      });
    }
 
    emitBoxesUpdate();
    res.json({ success: true, resetCount: boxNumbers.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// ---- GET /api/boxes/reset-history/list (full_access) ----
adminApi.get("/boxes/reset-history/list", readLimiter, requireFullAccess, async (req, res) => {
  try {
    const snap = await db.ref("resetHistory").once("value");
    const all = snap.val() || {};
    const records = Object.keys(all)
      .map((id) => ({ _id: id, ...all[id] }))
      .sort((a, b) => b.resetAt - a.resetAt);
    res.json({ records });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// ---- POST /api/boxes/reset-history/:id/restore (full_access) ----
adminApi.post("/boxes/reset-history/:id/restore", writeLimiter, requireFullAccess, async (req, res) => {
  try {
    const recordRef = db.ref(`resetHistory/${req.params.id}`);
    const snap = await recordRef.once("value");
    const record = snap.val();
 
    if (!record) return res.status(404).json({ error: "Reset record not found" });
    if (record.restored) return res.status(400).json({ error: "This reset was already restored" });
 
    await db.ref(`boxes/${record.boxNumber}`).set(record.snapshot || null);
    await recordRef.update({ restored: true, restoredAt: Date.now(), restoredBy: req.adminUser.username });
 
    emitBoxesUpdate();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// ---- POST /api/users (full_access) — create a dashboard operator ----
adminApi.post("/users", writeLimiter, requireFullAccess, async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required" });
    }
    if (!["full_access", "monitoring_only"].includes(role)) {
      return res.status(400).json({ error: "role must be full_access or monitoring_only" });
    }
 
    const existing = await findAdminUserByUsername(username);
    if (existing) {
      return res.status(409).json({ error: "A user with this username already exists" });
    }
 
    const passwordHash = await bcrypt.hash(password, 10);
    const ref = db.ref("adminUsers").push();
    await ref.set({ username, passwordHash, role, active: true, createdAt: Date.now() });
 
    res.status(201).json({ success: true, user: { id: ref.key, username, role, active: true } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// ---- GET /api/users (full_access) ----
adminApi.get("/users", readLimiter, requireFullAccess, async (req, res) => {
  try {
    const snap = await db.ref("adminUsers").once("value");
    const all = snap.val() || {};
    const users = Object.keys(all).map((id) => ({
      _id: id,
      username: all[id].username,
      role: all[id].role,
      active: all[id].active,
      createdAt: all[id].createdAt,
    }));
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
// ---- PATCH /api/users/:id (full_access) — activate/deactivate ----
adminApi.patch("/users/:id", writeLimiter, requireFullAccess, async (req, res) => {
  try {
    const { active } = req.body;
    if (typeof active !== "boolean") {
      return res.status(400).json({ error: "active must be a boolean" });
    }
    if (req.params.id === req.adminUser.userId && active === false) {
      return res.status(400).json({ error: "You cannot deactivate your own account" });
    }
 
    const userRef = db.ref(`adminUsers/${req.params.id}`);
    const snap = await userRef.once("value");
    if (!snap.exists()) return res.status(404).json({ error: "User not found" });
 
    await userRef.update({ active });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
 
/* ============================================================================
   NEW: HTTP server + Socket.IO for live dashboard updates
   ============================================================================ */
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: "*" },
});
 
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Missing auth token"));
    socket.adminUser = jwt.verify(token, ADMIN_JWT_SECRET);
    next();
  } catch (err) {
    next(new Error("Invalid or expired token"));
  }
});
 
io.on("connection", (socket) => {
  console.log(`🔌 Dashboard socket connected: ${socket.adminUser?.username}`);
  socket.on("disconnect", () => {
    console.log(`🔌 Dashboard socket disconnected: ${socket.adminUser?.username}`);
  });
});
 
// Throttled emit so a burst of Firebase writes doesn't spam every socket.
let emitPending = false;
function emitBoxesUpdate() {
  if (emitPending) return;
  emitPending = true;
  setTimeout(() => {
    io.emit("boxes:update");
    emitPending = false;
  }, 500);
}
 
// Any change anywhere under /boxes (purchases, cron champion upgrades,
// admin reward/reset) pushes a live update to connected dashboards.
db.ref("boxes").on("value", () => emitBoxesUpdate());


checkAndUpdateDefensePoints();
bootstrapFirstAdminUser();
// Run every 5 minutes
// cron.schedule('*/5 * * * *', async () => {
//   await checkAndUpdateDefensePoints();
// });
cron.schedule('* * * * *', async () => {
  await checkAndUpdateDefensePoints();
  await cleanupExpiredLocks(); // <-- ADD THIS
  await processFailedRefunds();
});
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Ready to accept requests`);
  console.log(`🛡️  Admin dashboard API mounted at /api`);
});
