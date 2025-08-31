// auth-service/config/mongoose.js
const mongoose = require("mongoose");

module.exports = async function connectMongo() {
    const uri = process.env.MONGO_URL || "mongodb://localhost:27017/hvwm_auth";
    mongoose.set("strictQuery", false);

    mongoose.connection.on("connected", () => console.log("[mongo] connected"));
    mongoose.connection.on("error", (e) => console.error("[mongo] error:", e.message));
    mongoose.connection.on("disconnected", () => console.warn("[mongo] disconnected"));

    await mongoose.connect(uri, {
        autoIndex: true,
        dbName: process.env.MONGO_DB || undefined,
    });
    return mongoose.connection;
};