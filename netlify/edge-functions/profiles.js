export default async (request, context) => {
  const supabaseUrl = context.env.get("SUPABASE_URL");
  const supabaseAnonKey = context.env.get("SUPABASE_ANON_KEY");

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

  if (!supabaseUrl || !supabaseAnonKey) {
    return new Response(JSON.stringify({ error: "SUPABASE_URL and SUPABASE_ANON_KEY must be set" }), {
      status: 500,
      headers: cors,
    });
  }

  const supabaseHeaders = {
    apikey: supabaseAnonKey,
    Authorization: `Bearer ${supabaseAnonKey}`,
    "Content-Type": "application/json",
  };

  // GET — load all profiles
  if (request.method === "GET") {
    try {
      const response = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.profiles&select=data`, {
        headers: {
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${supabaseAnonKey}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Supabase GET failed: ${response.status}`);
      }

      const rows = await response.json();
      const data = Array.isArray(rows) && rows[0]?.data ? rows[0].data : {};
      return new Response(JSON.stringify(data || {}), { status: 200, headers: cors });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message, profiles: {} }), { status: 200, headers: cors });
    }
  }

  // PUT — save all profiles
  if (request.method === "PUT") {
    try {
      const body = await request.json();
      const response = await fetch(`${supabaseUrl}/rest/v1/profiles?on_conflict=id`, {
        method: "POST",
        headers: {
          ...supabaseHeaders,
          Prefer: "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify({ id: "profiles", data: body }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Supabase PUT failed: ${response.status} ${errorText}`);
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
    }
  }

  return new Response("Method not allowed", { status: 405, headers: cors });
};

export const config = { path: "/api/profiles" };
