// /api/license/[...slug].js — ONE file for Lemon Squeezy licensing on Vercel
// Endpoints:
//   POST /api/license/verify   { licenseKey, instanceId? } -> { ok, plan, entitlements, status, expires? }
//   POST /api/license/activate { licenseKey, instanceName?, instanceId? } -> { ok, instanceId }
//
// 1) In Vercel -> Project -> Settings -> Environment Variables:
//      LS_LICENSE_API_KEY = <your Lemon Squeezy License API key>
// 2) Replace the THREE product IDs below with your real LS Product IDs.

const PLAN_MAP = {
  // ⬇️ REPLACE these with your actual Lemon Squeezy product IDs
  CORE_PRODUCT_ID:    { plan: "core",    ent: { advancedPresets:false, backtestTemplates:false, prioritySupport:false, officeHours:false } },
  PRO_PRODUCT_ID:     { plan: "pro",     ent: { advancedPresets:true,  backtestTemplates:true,  prioritySupport:true,  officeHours:true  } },
  FOUNDER_PRODUCT_ID: { plan: "founder", ent: { advancedPresets:true,  backtestTemplates:true,  prioritySupport:true,  officeHours:true  } }
};

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

async function ls(endpoint, body, apiKey) {
  const r = await fetch(`https://api.lemonsqueezy.com${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  const json = await r.json().catch(() => ({}));
  return { ok: r.ok, json };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const apiKey = process.env.LS_LICENSE_API_KEY;
  if (!apiKey) return res.status(500).json({ ok:false, reason:"missing_api_key" });

  const action = Array.isArray(req.query.slug) ? req.query.slug[0] : "";
  let body = {};
  try { body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {}); } catch {}

  if (action === "verify" && req.method === "POST") {
    const { licenseKey, instanceId } = body;
    const { ok, json } = await ls("/v1/licenses/validate", { license_key: licenseKey, instance_id: instanceId || null }, apiKey);
    if (!ok || !json.valid) return res.status(401).json({ ok:false, reason: json.error || "invalid" });

    const pid = json?.meta?.order_item?.product_id;
    const map = PLAN_MAP[pid] || PLAN_MAP.CORE_PRODUCT_ID;

    return res.status(200).json({
      ok: true,
      plan: map.plan,
      entitlements: map.ent,
      status: json?.license_key?.status || "active",
      // subscriptions will have a next renewal; lifetime will be null
      expires: json?.meta?.subscription_renews_at || null
    });
  }

  if (action === "activate" && req.method === "POST") {
    const { licenseKey, instanceName, instanceId } = body;
    const { ok, json } = await ls("/v1/licenses/activate", {
      license_key: licenseKey,
      instance_name: instanceName || "TrueTrend",
      instance_id: instanceId || null
    }, apiKey);
    if (!ok || !json.activated) return res.status(400).json({ ok:false, reason: json.error || "activate_failed" });
    return res.status(200).json({ ok:true, instanceId: json.instance?.id || instanceId || null });
  }

  return res.status(404).json({ ok:false });
}
