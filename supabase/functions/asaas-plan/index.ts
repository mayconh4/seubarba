// Assinatura mensal da plataforma (R$ 59,90) cobrada no cartão via Asaas.
// Ações: subscribe (cria assinatura), status (consulta), cancel (cancela).
const ASAAS_URL = Deno.env.get("ASAAS_ENV") === "prod"
  ? "https://api.asaas.com/v3"
  : "https://api-sandbox.asaas.com/v3";
const KEY = Deno.env.get("ASAAS_API_KEY")!;
const PLAN_VALUE = 59.90;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

const ADMIN_EMAIL = "maycontuliofs@gmail.com";
// e-mail de quem chamou, extraído do JWT do Supabase (não confiável = vazio)
function callerEmail(req: Request): string {
  try {
    const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const payload = JSON.parse(atob(tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return String(payload.email || "").toLowerCase();
  } catch { return ""; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json();
    const h = { "Content-Type": "application/json", access_token: KEY };

    // resolve link curto do Google Maps (maps.app.goo.gl) até a URL completa com coordenadas
    if (body.action === "maps-resolve") {
      const OK_HOSTS = ["maps.app.goo.gl", "goo.gl", "g.co", "maps.google.com", "www.google.com", "google.com", "maps.googleapis.com", "www.google.com.br", "google.com.br"];
      let url = String(body.url || "").trim();
      for (let i = 0; i < 6; i++) {
        let host = "";
        try { host = new URL(url).hostname.toLowerCase(); } catch { return json({ error: "url inválida" }, 400); }
        if (!OK_HOSTS.some((h2) => host === h2)) return json({ error: "domínio não permitido" }, 400);
        const r = await fetch(url, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0" } });
        const loc = r.headers.get("location");
        if (loc) { url = new URL(loc, url).href; continue; }
        // sem redirect: procura coordenadas no corpo da página como último recurso
        const texto = await r.text();
        const m = /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/.exec(url) || /(-?\d{1,2}\.\d{4,}),(-?\d{1,3}\.\d{4,})/.exec(texto);
        return json({ finalUrl: url, lat: m ? +m[1] : null, lng: m ? +m[2] : null });
      }
      return json({ finalUrl: url });
    }

    // visão administrativa: pagamentos e assinaturas de toda a plataforma
    if (body.action === "admin-overview") {
      if (callerEmail(req) !== ADMIN_EMAIL) return json({ error: "acesso restrito" }, 403);
      const [pays, subs] = await Promise.all([
        fetch(`${ASAAS_URL}/payments?limit=100&offset=0`, { headers: h }).then((r) => r.json()),
        fetch(`${ASAAS_URL}/subscriptions?limit=100&offset=0`, { headers: h }).then((r) => r.json()),
      ]);
      return json({
        payments: (pays.data || []).map((p: any) => ({
          id: p.id, value: p.value, netValue: p.netValue, status: p.status,
          date: p.paymentDate || p.dueDate, desc: p.description || "", type: p.billingType,
        })),
        subs: (subs.data || []).map((s: any) => ({
          id: s.id, value: s.value, status: s.status, nextDue: s.nextDueDate, desc: s.description || "",
        })),
      });
    }

    if (body.action === "status") {
      const s = await (await fetch(`${ASAAS_URL}/subscriptions/${body.subscriptionId}`, { headers: h })).json();
      return json({ status: s.status || "UNKNOWN", deleted: !!s.deleted });
    }

    if (body.action === "cancel") {
      const s = await (await fetch(`${ASAAS_URL}/subscriptions/${body.subscriptionId}`, { method: "DELETE", headers: h })).json();
      return json({ deleted: !!s.deleted });
    }

    // subscribe
    const { nome, email, cpfCnpj, phone, postalCode, addressNumber, card } = body;
    const doc = String(cpfCnpj || "").replace(/\D/g, "");
    const fone = String(phone || "").replace(/\D/g, "");

    // cliente do dono da barbearia (cria ou reaproveita)
    const busca = await (await fetch(`${ASAAS_URL}/customers?cpfCnpj=${doc}`, { headers: h })).json();
    let customerId = busca.data?.[0]?.id;
    if (!customerId) {
      const novo = await (await fetch(`${ASAAS_URL}/customers`, {
        method: "POST", headers: h,
        body: JSON.stringify({ name: nome, cpfCnpj: doc, email, ...(fone ? { mobilePhone: fone } : {}) }),
      })).json();
      if (!novo.id) throw new Error(JSON.stringify(novo.errors || novo));
      customerId = novo.id;
    }

    // assinatura mensal no cartão; o Asaas tokeniza e cobra todo mês sozinho
    const sub = await (await fetch(`${ASAAS_URL}/subscriptions`, {
      method: "POST", headers: h,
      body: JSON.stringify({
        customer: customerId,
        billingType: "CREDIT_CARD",
        value: PLAN_VALUE,
        nextDueDate: new Date().toISOString().slice(0, 10),
        cycle: "MONTHLY",
        description: "Plano SeuBarba — uso da plataforma",
        creditCard: {
          holderName: card.holderName,
          number: String(card.number || "").replace(/\D/g, ""),
          expiryMonth: card.expiryMonth,
          expiryYear: card.expiryYear,
          ccv: card.ccv,
        },
        creditCardHolderInfo: {
          name: nome, email, cpfCnpj: doc,
          postalCode: String(postalCode || "").replace(/\D/g, ""),
          addressNumber: String(addressNumber || "s/n"),
          ...(fone ? { mobilePhone: fone, phone: fone } : {}),
        },
      }),
    })).json();
    if (!sub.id) throw new Error(JSON.stringify(sub.errors || sub));
    return json({ subscriptionId: sub.id, status: sub.status });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
