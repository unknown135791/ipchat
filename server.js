// server.js

require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");

const app = express();
app.disable('x-powered-by');

const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public", { maxAge: "1d" }));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

const roomUsers = {};

// Validation & Sanitization Helpers
const usernameRegex = /^[a-zA-Z0-9_ -]{1,20}$/;
const roomRegex = /^[a-zA-Z0-9_-]{1,20}$/;

function sanitizeInput(str) {
    if (typeof str !== "string") return "";
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#x27;")
        .replace(/\//g, "&#x2F;");
}

// In-memory rate limiting tracking (socket.id -> timestamps)
const rateLimiter = {};

let dbConnected = false;

// Database connection
pool.connect()
    .then(() => {
        dbConnected = true;
        console.log("Database connected");
    })
    .catch((err) => {
        dbConnected = false;
        console.log("Database connection failed. Continuing in local-only mode. Error:", err.message);
    });

// Load old messages
app.get("/messages/:room", async (req, res) => {
    try {
        if (!dbConnected) {
            return res.json([]);
        }
        const room = req.params.room;
        const result = await pool.query(
            `SELECT * FROM messages
             WHERE room_code = $1
             ORDER BY created_at ASC`,
            [room]
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Database query failed:", err.message);
        res.json([]); // Fail-safe return empty history so room still loads!
    }
});

// Home route
app.get("/", (req, res) => {
    res.send("IPChat running");
});

// Socket.IO
io.on("connection", (socket) => {

    console.log("User connected");

    // Join room
    socket.on("join-room", (data) => {
        if (!data || !data.roomId || !data.username) {
            socket.emit("join-failure", "Room ID and Username are required.");
            return;
        }

        const cleanRoomId = data.roomId.trim();
        const cleanUsername = data.username.trim();

        if (!roomRegex.test(cleanRoomId)) {
            socket.emit("join-failure", "Room ID must be 1-20 characters (letters, numbers, underscores, dashes).");
            return;
        }

        if (!usernameRegex.test(cleanUsername)) {
            socket.emit("join-failure", "Username must be 1-20 characters (letters, numbers, spaces, underscores, dashes).");
            return;
        }

        // Check for duplicate username in that room (case-insensitive)
        if (roomUsers[cleanRoomId] && roomUsers[cleanRoomId].some(u => u.toLowerCase() === cleanUsername.toLowerCase())) {
            socket.emit("join-failure", "Username is already taken in this room.");
            return;
        }

        socket.join(cleanRoomId);
        socket.roomId = cleanRoomId;
        socket.username = cleanUsername;

        // Create room array
        if(!roomUsers[cleanRoomId]){
            roomUsers[cleanRoomId] = [];
        }

        // Add user
        roomUsers[cleanRoomId].push(cleanUsername);

        // Send updated user list
        io.to(cleanRoomId).emit(
            "user-list",
            roomUsers[cleanRoomId]
        );

        // Join message
        socket.to(cleanRoomId).emit(
            "system-message",
            `${cleanUsername} joined`
        );

        console.log(`${cleanUsername} joined ${cleanRoomId}`);
    });

    // Typing event
    socket.on("typing", (data) => {
        socket.to(data.roomId).emit("typing", {
            username: data.username,
            isTyping: data.isTyping
        });
    });

    // Send message
    socket.on("send-message", async (data) => {
        try {
            if (!data || !data.roomId || !data.sender || !data.message) return;

            const cleanRoomId = data.roomId.trim();
            const cleanSender = data.sender.trim();
            const rawMessage = data.message.trim();

            // 1. Reject empty messages
            if (rawMessage === "") return;

            // 2. Rate-Limiting: Max 5 messages per 3 seconds per socket
            const now = Date.now();
            if (!rateLimiter[socket.id]) {
                rateLimiter[socket.id] = [];
            }
            rateLimiter[socket.id] = rateLimiter[socket.id].filter(t => now - t < 3000);
            if (rateLimiter[socket.id].length >= 5) {
                socket.emit("system-message", "You are sending messages too fast.");
                return;
            }
            rateLimiter[socket.id].push(now);

            // 3. Limit message length (max 1000 characters)
            let limitedMessage = rawMessage;
            if (limitedMessage.length > 1000) {
                limitedMessage = limitedMessage.substring(0, 1000);
            }

            // 4. Sanitize HTML
            const sanitizedMessage = sanitizeInput(limitedMessage);

            // Realtime send
            io.to(cleanRoomId).emit(
                "receive-message",
                {
                    sender: cleanSender,
                    message: sanitizedMessage
                }
            );

            // Save to DB
            if (dbConnected) {
                try {
                    await pool.query(
                        `INSERT INTO messages
                        (room_code, sender, message)
                        VALUES ($1, $2, $3)`,
                        [cleanRoomId, cleanSender, sanitizedMessage]
                    );
                } catch (dbErr) {
                    console.error("Database insert failed:", dbErr.message);
                }
            }

        } catch (err) {
            console.log(err);
        }
    });

    // Clear chat
    socket.on("clear-chat", async (data) => {
        try {
            const roomId = (data && data.roomId) ? data.roomId.trim() : socket.roomId;
            if (!roomId) {
                console.log("[Clear Chat Failed] No roomId found on socket or payload.");
                return;
            }

            console.log(`[Clear Chat Initiated] Clearing messages for room: ${roomId}`);

            if (dbConnected) {
                try {
                    await pool.query(
                        "DELETE FROM messages WHERE room_code = $1",
                        [roomId]
                    );
                    console.log(`[Clear Chat DB] Deleted messages from PostgreSQL for room: ${roomId}`);
                } catch (dbErr) {
                    console.error(`[Clear Chat Failed DB] Failed to delete messages for room: ${roomId}`, dbErr.message);
                }
            } else {
                console.log(`[Clear Chat DB] Local-only mode. No DB deletion needed.`);
            }

            io.to(roomId).emit("chat-cleared");
            console.log(`[Clear Chat Success] Broadcasted 'chat-cleared' to room: ${roomId}`);

        } catch (err) {
            console.log(err);
        }
    });

    // Disconnect
    socket.on("disconnect", () => {
        const roomId = socket.roomId;
        const username = socket.username;

        // Clean up rate-limiter memory
        delete rateLimiter[socket.id];

        if(roomId && roomUsers[roomId]){
            // Clear typing state for other clients
            socket.to(roomId).emit("typing", {
                username: username,
                isTyping: false
            });

            roomUsers[roomId] =
                roomUsers[roomId].filter(
                    user => user !== username
                );

            io.to(roomId).emit(
                "user-list",
                roomUsers[roomId]
            );

            socket.to(roomId).emit(
                "system-message",
                `${username} left`
            );

            // Clean up empty room in-memory tracking to prevent memory leaks
            if (roomUsers[roomId].length === 0) {
                delete roomUsers[roomId];
                console.log(`[Room Cleanup] Memory cleaned for room: ${roomId}`);

                if (dbConnected) {
                    pool.query(
                        "DELETE FROM messages WHERE room_code = $1",
                        [roomId]
                    ).then(() => {
                        console.log(`[Room Cleanup] Messages deleted from PostgreSQL for room: ${roomId}`);
                        console.log(`[Room Cleanup] Room disposed successfully: ${roomId}`);
                    }).catch((dbErr) => {
                        console.error(`[Room Cleanup] Failed to delete messages for room: ${roomId}`, dbErr.message);
                    });
                } else {
                    console.log(`[Room Cleanup] Room disposed successfully (Local-only mode): ${roomId}`);
                }
            }
        }

        console.log("User disconnected");
    });

});

// Custom 404 handler
app.use((req, res) => {
    res.status(404).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>404 - Page Not Found | IPChat</title>
            <link rel="stylesheet" href="/style.css">
            <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2280%22>💬</text></svg>">
            <style>
                body { flex-direction: column; gap: 20px; }
                .error-container { text-align: center; max-width: 400px; }
                .error-code { font-size: 80px; font-weight: 800; color: #3b82f6; margin: 0; filter: drop-shadow(0 0 15px rgba(59, 130, 246, 0.4)); }
                .error-desc { font-size: 16px; color: rgba(255, 255, 255, 0.7); margin-bottom: 20px; }
                .home-btn { display: inline-block; text-decoration: none; padding: 12px 24px; border-radius: 12px; background: #3b82f6; color: white; font-weight: 600; transition: transform 0.2s, box-shadow 0.2s; }
                .home-btn:hover { transform: translateY(-2px); box-shadow: 0 0 20px rgba(59, 130, 246, 0.5); }
            </style>
        </head>
        <body>
            <div class="container error-container">
                <h1 class="error-code">404</h1>
                <h2>Page Not Found</h2>
                <p class="error-desc">The room or page you are looking for does not exist or has been moved.</p>
                <a href="/" class="home-btn">Return Home</a>
            </div>
        </body>
        </html>
    `);
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`IPChat running on http://localhost:${PORT}`);
});