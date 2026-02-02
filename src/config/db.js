import mongoose from "mongoose";
import { config } from "./env.js";

export const connectDB = async () => {
  try {
    if (!config.mongodb.uri) {
      console.warn(
        "⚠️ No MONGO_URI provided. Skipping MongoDB connection (development mode).",
      );
      return;
    }
    const conn = await mongoose.connect(config.mongodb.uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log(`✅ MongoDB connected: ${conn.connection.host}`);
  } catch (error) {
    console.error("❌ MongoDB connection error:", error);
    process.exit(1);
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
