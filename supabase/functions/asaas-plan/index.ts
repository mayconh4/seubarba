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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json();
    const h = { "Content-Type": "application/json", access_token: KEY };

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
