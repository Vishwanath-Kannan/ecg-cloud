import WebSocket, { WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: process.env.PORT || 8080 });

console.log("ECG Cloud Server Running");

let latestPacket = null;

wss.on("connection", ws => {
  ws.on("message", msg => {
    latestPacket = msg.toString();

    // Broadcast to all viewers
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(latestPacket);
      }
    });
  });
});
