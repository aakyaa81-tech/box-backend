const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// Parse the service account from environment variable
let serviceAccount;
try {
  // Try to get from environment variable (Render.com)
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log("✅ Using service account from environment variable");
  } else {
    // Fallback for local testing
    serviceAccount = require("./serviceAccountKey.json");
    console.log("✅ Using service account from file");
  }
} catch(e) {
  console.error("❌ Failed to parse service account:", e.message);
  process.exit(1);
}

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://solanatradingboxes-default-rtdb.firebaseio.com"
});

const db = admin.database();
console.log("✅ Firebase Admin initialized successfully");

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
  } catch(error) {
    console.error("Error getting boxes:", error);
    res.status(500).json({ error: error.message });
  }
});

// Update a single box
app.post("/updateBox", async (req, res) => {
  try {
    const { boxNumber, boxData } = req.body;
    
    if (!boxNumber || !boxData) {
      return res.status(400).json({ error: "Missing boxNumber or boxData" });
    }
    
    await db.ref(`boxes/${boxNumber}`).set(boxData);
    console.log(`✅ Box ${boxNumber} updated`);
    res.json({ success: true, boxNumber });
  } catch(error) {
    console.error("Error updating box:", error);
    res.status(500).json({ error: error.message });
  }
});

// Save a transaction
app.post("/saveTransaction", async (req, res) => {
  try {
    const { boxNumber, transactionId, data } = req.body;
    
    if (!boxNumber || !transactionId || !data) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    
    await db.ref(`transactions/${boxNumber}/${transactionId}`).set(data);
    console.log(`✅ Transaction saved for box ${boxNumber}`);
    res.json({ success: true });
  } catch(error) {
    console.error("Error saving transaction:", error);
    res.status(500).json({ error: error.message });
  }
});

// Save defense points
app.post("/saveDefense", async (req, res) => {
  try {
    const { wallet, boxNumber, points } = req.body;
    
    if (!wallet || !boxNumber || points === undefined) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    
    // Validate points range (0-5)
    const validPoints = Math.min(5, Math.max(0, points));
    
    await db.ref(`defenses/${wallet}/${boxNumber}`).set(validPoints);
    console.log(`✅ Defense points saved: ${wallet} box ${boxNumber} = ${validPoints}`);
    res.json({ success: true });
  } catch(error) {
    console.error("Error saving defense points:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get defense points for a wallet
app.get("/getDefense/:wallet/:boxNumber", async (req, res) => {
  try {
    const { wallet, boxNumber } = req.params;
    const snapshot = await db.ref(`defenses/${wallet}/${boxNumber}`).once("value");
    res.json({ points: snapshot.val() || 0 });
  } catch(error) {
    console.error("Error getting defense points:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Ready to accept requests`);
});
