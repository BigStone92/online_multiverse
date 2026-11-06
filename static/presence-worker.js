/**
 * Online_Multiverse — Dedicated WebSocket Presence Worker
 * Reconstructed from REA evidence ev_88ba890507c24458b1f176133a7cf9b7dc45571aafadaf54ee2a7d0410f4bceb
 * (presence-worker-D7eFbKrZ.js: zero-copy Transferable ArrayBuffer forwarding + exponential backoff)
 */

let socket = null;
let targetUrl = "";
let isIdle = false;
let isDisposed = false;
let attempt = 0;
let reconnectTimer = null;

function clearReconnect() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function closeSocket() {
  if (!socket) return;
  const ws = socket;
  socket = null;
  ws.onopen = null;
  ws.onmessage = null;
  ws.onerror = null;
  ws.onclose = null;
  try {
    ws.close();
  } catch (_err) {
    // ignore close errors
  }
}

function scheduleReconnect() {
  if (isDisposed || isIdle || !targetUrl || reconnectTimer !== null) return;
  const delay = Math.min(15000, 700 * Math.pow(2, Math.min(attempt++, 5)) + Math.random() * 350);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openConnection();
  }, delay);
}

function openConnection() {
  clearReconnect();
  closeSocket();
  if (isDisposed || !targetUrl) return;

  self.postMessage({ type: "status", status: "connecting" });
  try {
    const ws = new WebSocket(targetUrl);
    ws.binaryType = "arraybuffer";
    socket = ws;

    ws.onopen = () => {
      if (socket !== ws) return;
      attempt = 0;
      self.postMessage({ type: "status", status: "connected" });
    };

    ws.onmessage = (event) => {
      if (socket !== ws) return;
      if (event.data instanceof ArrayBuffer) {
        self.postMessage({ type: "binary", buffer: event.data }, [event.data]);
      } else if (typeof event.data === "string") {
        self.postMessage({ type: "message", text: event.data });
      }
    };

    ws.onerror = () => {
      // Handled in onclose
    };

    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      self.postMessage({ type: "status", status: "disconnected" });
      scheduleReconnect();
    };
  } catch (_err) {
    self.postMessage({ type: "status", status: "disconnected" });
    scheduleReconnect();
  }
}

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;

  switch (msg.type) {
    case "connect":
      targetUrl = String(msg.url || "");
      isIdle = Boolean(msg.idle);
      attempt = 0;
      openConnection();
      break;

    case "send":
      if (socket && socket.readyState === WebSocket.OPEN && msg.data !== undefined) {
        try {
          socket.send(msg.data);
        } catch (_err) {
          // ignore send errors on closing socket
        }
      }
      break;

    case "set-idle":
      isIdle = Boolean(msg.idle);
      if (isIdle) {
        clearReconnect();
      } else if (!socket && targetUrl) {
        openConnection();
      }
      break;

    case "disconnect":
      clearReconnect();
      if (msg.clearUrl) targetUrl = "";
      closeSocket();
      self.postMessage({ type: "status", status: "disconnected" });
      break;

    case "dispose":
      isDisposed = true;
      clearReconnect();
      targetUrl = "";
      closeSocket();
      break;
  }
};
