import mongoose from "mongoose";
import { config } from "./env.js";

let isConnecting = false;
let isConnected = false;

export const connectDB = async () => {
  // Prevent multiple simultaneous connection attempts
  if (isConnected) {
    console.log("✅ Using existing MongoDB connection");
    return;
  }

  if (isConnecting) {
    console.log("⏳ MongoDB connection in progress...");
    return;
  }

  try {
    if (!config.mongodb.uri) {
      console.warn(
        "⚠️ No MONGO_URI provided. Skipping MongoDB connection (development mode).",
      );
      return;
    }

    isConnecting = true;

    const conn = await mongoose.connect(config.mongodb.uri, {
      serverSelectionTimeoutMS: 5000,
      maxPoolSize: 10,
    });

    isConnected = true;
    isConnecting = false;
    console.log(`✅ MongoDB connected: ${conn.connection.host}`);
  } catch (error) {
    isConnecting = false;
    isConnected = false;
    console.error("❌ MongoDB connection error:", error.message);

    // In serverless, don't exit - just log and allow retry
    if (!process.env.VERCEL) {
      process.exit(1);
    }
  }
};

// Handle connection events
mongoose.connection.on("disconnected", () => {
  console.log("📡 MongoDB disconnected");
});

mongoose.connection.on("error", (err) => {
  console.error("❌ MongoDB error:", err);
});

process.on("SIGINT", async () => {
  await mongoose.connection.close();
  console.log("📡 MongoDB connection closed through app termination");
  process.exit(0);
});
