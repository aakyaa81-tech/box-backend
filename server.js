const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");

const app = express();

/* -------------------- MIDDLEWARE -------------------- */

app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json({
  limit: "10mb"
}));

/* -------------------- FIREBASE INIT -------------------- */

let serviceAccount;

try {

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {

    serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT
    );

    console.log("✅ Using ENV Firebase credentials");

  } else {

    serviceAccount = require("./serviceAccountKey.json");

    console.log("✅ Using local Firebase credentials");

  }

} catch (e) {

  console.error("❌ Firebase credential error:");
  console.error(e);

  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL:
    "https://solanatradingboxes-default-rtdb.firebaseio.com"
});

const db = admin.database();

console.log("✅ Firebase initialized");

/* -------------------- HEALTH CHECK -------------------- */

app.get("/", async (req, res) => {

  res.status(200).json({
    success: true,
    message: "Backend running",
    timestamp: Date.now()
  });

});

/* -------------------- GET ALL BOXES -------------------- */

app.get("/getBoxes", async (req, res) => {

  try {

    const snapshot = await db.ref("boxes").once("value");

    const data = snapshot.val() || {};

    res.status(200).json(data);

  } catch (e) {

    console.error("❌ getBoxes error:", e);

    res.status(500).json({
      success: false,
      error: e.message
    });
  }

});

/* -------------------- UPDATE BOX -------------------- */

app.post("/updateBox", async (req, res) => {

  try {

    const { boxNumber, boxData } = req.body;

    if (!boxNumber || !boxData) {

      return res.status(400).json({
        success: false,
        error: "Missing boxNumber or boxData"
      });

    }

    await db.ref(`boxes/${boxNumber}`).set(boxData);

    console.log(`✅ Box updated: ${boxNumber}`);

    res.status(200).json({
      success: true,
      boxNumber
    });

  } catch (e) {

    console.error("❌ updateBox error:", e);

    res.status(500).json({
      success: false,
      error: e.message
    });

  }

});

/* -------------------- SAVE TRANSACTION -------------------- */

app.post("/saveTransaction", async (req, res) => {

  try {

    const {
      boxNumber,
      transactionId,
      data
    } = req.body;

    if (!boxNumber || !transactionId || !data) {

      return res.status(400).json({
        success: false,
        error: "Missing fields"
      });

    }

    await db
      .ref(`transactions/${boxNumber}/${transactionId}`)
      .set(data);

    console.log(`✅ Transaction saved: ${transactionId}`);

    res.status(200).json({
      success: true
    });

  } catch (e) {

    console.error("❌ saveTransaction error:", e);

    res.status(500).json({
      success: false,
      error: e.message
    });

  }

});

/* -------------------- SAVE DEFENSE -------------------- */

app.post("/saveDefense", async (req, res) => {

  try {

    const {
      wallet,
      boxNumber,
      points
    } = req.body;

    if (
      !wallet ||
      !boxNumber ||
      points === undefined
    ) {

      return res.status(400).json({
        success: false,
        error: "Missing fields"
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
      `✅ Defense saved ${wallet} #${boxNumber} = ${safePoints}`
    );

    res.status(200).json({
      success: true
    });

  } catch (e) {

    console.error("❌ saveDefense error:", e);

    res.status(500).json({
      success: false,
      error: e.message
    });

  }

});

/* -------------------- GET DEFENSE -------------------- */

app.get("/getDefense/:wallet/:boxNumber", async (req, res) => {

  try {

    const { wallet, boxNumber } = req.params;

    const snapshot = await db
      .ref(`defenses/${wallet}/${boxNumber}`)
      .once("value");

    const points = snapshot.val() || 0;

    res.status(200).json({
      success: true,
      points
    });

  } catch (e) {

    console.error("❌ getDefense error:", e);

    res.status(500).json({
      success: false,
      error: e.message
    });

  }

});

/* -------------------- ERROR HANDLER -------------------- */

app.use((err, req, res, next) => {

  console.error("❌ GLOBAL ERROR:");
  console.error(err);

  res.status(500).json({
    success: false,
    error: err.message || "Internal server error"
  });

});

/* -------------------- START SERVER -------------------- */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {

  console.log("=================================");
  console.log(`🚀 SERVER RUNNING ON ${PORT}`);
  console.log("=================================");

});
