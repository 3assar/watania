import { getStore } from "https://esm.sh/@netlify/blobs@8";

export default async (request, context) => {
  const store = getStore({ name: "awp-profiles", consistency: "strong" });

  // CORS headers so the HTML page can call this API
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  // Handle preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  // GET — load all profiles
  if (request.method === "GET") {
    try {
      const data = await store.get("profiles", { type: "json" });
      return new Response(JSON.stringify(data || {}), { status: 200, headers: cors });
    } catch (e) {
      return new Response(JSON.stringify({}), { status: 200, headers: cors });
    }
  }

  // PUT — save all profiles
  if (request.method === "PUT") {
    try {
      const body = await request.json();
      await store.setJSON("profiles", body);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
    }
  }

  return new Response("Method not allowed", { status: 405, headers: cors });
};

export const config = { path: "/api/profiles" };
