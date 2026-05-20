const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");

const app = express();

/* =========================
   MIDDLEWARE
========================= */
app.use(cors());
app.use(express.json({ limit: "10mb" }));

/* =========================
   FIREBASE INIT
========================= */

let serviceAccount;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log("✅ Using FIREBASE_SERVICE_ACCOUNT from environment");
  } else {
    serviceAccount = require("./serviceAccountKey.json");
    console.log("✅ Using local serviceAccountKey.json");
  }
} catch (e) {
  console.error("❌ Firebase service account error:", e);
  process.exit(1);
}

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL:
      "https://solanatradingboxes-default-rtdb.firebaseio.com",
  });

  console.log("✅ Firebase Admin initialized");
} catch (e) {
  console.error("❌ Firebase initialize failed:", e);
  process.exit(1);
}

const db = admin.database();

/* =========================
   ROOT
========================= */

app.get("/", async (req, res) => {
  res.json({
    success: true,
    message: "BOX backend is running",
    time: new Date().toISOString(),
  });
});

/* =========================
   TEST ROUTE
========================= */

app.get("/test", async (req, res) => {
  try {
    await db.ref("serverTest").set({
      time: Date.now(),
      status: "working",
    });

    res.json({
      success: true,
      message: "Firebase write success",
    });
  } catch (e) {
    console.error(e);

    res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

/* =========================
   GET ALL BOXES
========================= */

app.get("/getBoxes", async (req, res) => {
  try {
    const snapshot = await db.ref("boxes").once("value");

    res.json({
      success: true,
      data: snapshot.val() || {},
    });
  } catch (e) {
    console.error("❌ getBoxes error:", e);

    res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

/* =========================
   UPDATE BOX
========================= */

app.post("/updateBox", async (req, res) => {
  try {
    const { boxNumber, boxData } = req.body;

    if (!boxNumber) {
      return res.status(400).json({
        success: false,
        error: "boxNumber missing",
      });
    }

    if (!boxData) {
      return res.status(400).json({
        success: false,
        error: "boxData missing",
      });
    }

    await db.ref(`boxes/${boxNumber}`).set(boxData);

    console.log(`✅ Box updated: ${boxNumber}`);

    res.json({
      success: true,
      boxNumber,
    });
  } catch (e) {
    console.error("❌ updateBox error:", e);

    res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

/* =========================
   SAVE TRANSACTION
========================= */

app.post("/saveTransaction", async (req, res) => {
  try {
    const { boxNumber, transactionId, data } = req.body;

    if (!boxNumber || !transactionId || !data) {
      return res.status(400).json({
        success: false,
        error: "Missing fields",
      });
    }

    await db
      .ref(`transactions/${boxNumber}/${transactionId}`)
      .set(data);

    console.log(
      `✅ Transaction saved for box ${boxNumber}`
    );

    res.json({
      success: true,
    });
  } catch (e) {
    console.error("❌ saveTransaction error:", e);

    res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

/* =========================
   SAVE DEFENSE POINTS
========================= */

app.post("/saveDefense", async (req, res) => {
  try {
    const { wallet, boxNumber, points } = req.body;

    if (!wallet || !boxNumber || points === undefined) {
      return res.status(400).json({
        success: false,
        error: "Missing fields",
      });
    }

    const safePoints = Math.max(
      0,
      Math.min(5, Number(points))
    );

    await db
      .ref(`defenses/${wallet}/${boxNumber}`)
      .set(safePoints);

    console.log(
      `✅ Defense saved: ${wallet} box ${boxNumber} = ${safePoints}`
    );

    res.json({
      success: true,
      points: safePoints,
    });
  } catch (e) {
    console.error("❌ saveDefense error:", e);

    res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

/* =========================
   GET DEFENSE
========================= */

app.get("/getDefense/:wallet/:boxNumber", async (req, res) => {
  try {
    const { wallet, boxNumber } = req.params;

    const snapshot = await db
      .ref(`defenses/${wallet}/${boxNumber}`)
      .once("value");

    res.json({
      success: true,
      points: snapshot.val() || 0,
    });
  } catch (e) {
    console.error("❌ getDefense error:", e);

    res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

/* =========================
   GET ALL DEFENSES FOR WALLET
========================= */

app.get("/getWalletDefenses/:wallet", async (req, res) => {
  try {
    const { wallet } = req.params;

    const snapshot = await db
      .ref(`defenses/${wallet}`)
      .once("value");

    res.json({
      success: true,
      data: snapshot.val() || {},
    });
  } catch (e) {
    console.error("❌ getWalletDefenses error:", e);

    res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

/* =========================
   DELETE BOX (OPTIONAL)
========================= */

app.delete("/deleteBox/:boxNumber", async (req, res) => {
  try {
    const { boxNumber } = req.params;

    await db.ref(`boxes/${boxNumber}`).remove();

    console.log(`🗑️ Deleted box ${boxNumber}`);

    res.json({
      success: true,
    });
  } catch (e) {
    console.error("❌ deleteBox error:", e);

    res.status(500).json({
      success: false,
      error: e.message,
    });
  }
});

/* =========================
   SERVER
========================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("=================================");
  console.log(`🚀 BOX BACKEND RUNNING`);
  console.log(`🌐 PORT: ${PORT}`);
  console.log("=================================");
});

/* =========================
   CRASH HANDLERS
========================= */

process.on("uncaughtException", (err) => {
  console.error("❌ uncaughtException:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("❌ unhandledRejection:", err);
});
