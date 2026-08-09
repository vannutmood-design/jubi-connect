import { createServerFn } from "@tanstack/react-start";

/**
 * Returns the ICE server list for WebRTC. STUN is always available; TURN is
 * added only when the TURN_* secrets are configured. Credentials never ship in
 * the client bundle — they are read here, on the server, at call time.
 */
export const getIceServers = createServerFn({ method: "GET" }).handler(async () => {
  const servers: RTCIceServer[] = [
    {
      urls: [
        "stun:stun.l.google.com:19302",
        "stun:stun1.l.google.com:19302",
        "stun:global.stun.twilio.com:3478",
      ],
    },
  ];

  const turnUrls = process.env["TURN_URLS"];
  const turnUsername = process.env["TURN_USERNAME"];
  const turnCredential = process.env["TURN_CREDENTIAL"];

  if (turnUrls && turnUsername && turnCredential) {
    servers.push({
      urls: turnUrls.split(",").map((u) => u.trim()).filter(Boolean),
      username: turnUsername,
      credential: turnCredential,
    });
  }

  return { iceServers: servers, hasTurn: Boolean(turnUrls && turnUsername && turnCredential) };
});