const ws = new WebSocket("wss://e-coli3.fbhcdbhf.workers.dev/api/session-websocket?sessionId=session_test_123");

ws.onopen = () => {
  console.log("WS Opened");
  ws.send(JSON.stringify({
    type: "INIT",
    userEmail: "fbhcdbhf@gmail.com",
    dbTicks: 49
  }));
};

ws.onmessage = (event) => {
  console.log("Received:", event.data);
  const data = JSON.parse(event.data);
  // Close after receiving TICK_UPDATE
  if (data.type === 'TICK_UPDATE') {
    console.log("Closing WebSocket...");
    ws.close();
  }
};

ws.onclose = () => {
  console.log("WS Closed");
};

ws.onerror = (err) => {
  console.error("WS Error:", err);
};
