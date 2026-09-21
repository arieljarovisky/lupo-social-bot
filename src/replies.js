const normalize = (value = '') => String(value).normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

const matches = (text, patterns) => patterns.some((pattern) => pattern.test(text));

/** Returns a conservative response. Never invents availability, prices or size. */
export function answerFor(message, { storeUrl = 'https://lupo.ar', whatsappNumber = '' } = {}) {
  const text = normalize(message);
  const store = storeUrl.replace(/\/+$/, '');
  const whatsapp = /^\d{10,15}$/.test(whatsappNumber)
    ? ` Podés contactarnos en https://wa.me/${whatsappNumber}.`
    : ' Un asesor puede ayudarte por este mismo chat.';

  if (matches(text, [/asesor/, /persona real/, /humano/, /operador/, /atencion personalizada/])) {
    return { intent: 'handoff', handoff: true,
      text: `¡Hola! 💙 Dejamos esta conversación para atención personalizada. Nuestro equipo puede continuar por la bandeja de mensajes.${whatsapp}` };
  }
  if (matches(text, [/reclamo/, /equivocad/, /devoluc/, /cambi[oa]/, /fallad/, /roto/, /no (me )?llego/, /no recib/, /cancelar/])) {
    return { intent: 'handoff', handoff: true,
      text: `¡Hola! 💙 Queremos ayudarte con tu pedido. Por favor, no compartas datos personales públicamente.${whatsapp}` };
  }
  if (matches(text, [/mayorist/, /por mayor/, /revend/, /distribuidor/, /lista de precios/])) {
    return { intent: 'wholesale', handoff: false,
      text: `¡Hola! 💙 Sí, trabajamos con ventas mayoristas. Contanos qué productos te interesan y te orientamos con las condiciones de compra.${whatsapp}` };
  }
  if (matches(text, [/tall[ea]/, /medid/, /cadera/, /cintura/, /busto/, /equivalenc/])) {
    return { intent: 'size', handoff: false,
      text: '¡Hola! 💙 Para orientarte con el talle necesitamos el código o enlace del producto y tus medidas relevantes. La guía cambia según el modelo; no queremos recomendarte un talle incorrecto.' };
  }
  if (matches(text, [/stock/, /disponib/, /tenes/, /tienen/, /hay en/, /color/, /negro/, /blanco/])) {
    return { intent: 'stock', handoff: false,
      text: `¡Hola! 💙 Pasanos el código del producto, talle y color que buscás. Podés ver los productos en ${store}. Confirmaremos la disponibilidad antes de asegurarte que está en stock.` };
  }
  if (matches(text, [/preci[oa]/, /cuanto (sale|cuesta|esta)/, /valor/, /\$[0-9]/])) {
    return { intent: 'price', handoff: false,
      text: `¡Hola! 💙 Pasanos el código o enlace del artículo para identificar la variante correcta. Podés consultar los precios publicados en ${store}; así evitamos pasarte un importe desactualizado.` };
  }
  if (matches(text, [/envio/, /despach/, /entrega/, /retir/, /seguimiento/, /correo/, /flex/])) {
    return { intent: 'shipping', handoff: false,
      text: `¡Hola! 💙 Hacemos envíos. El costo y plazo dependen del destino y del pedido. Podés consultar las opciones durante la compra en ${store}. Para un pedido existente, escribinos por privado y lo revisa el equipo.` };
  }
  if (matches(text, [/compr/, /catalog/, /tienda/, /web/, /link/, /donde/])) {
    return { intent: 'shop', handoff: false,
      text: `¡Hola! 💙 Podés ver nuestros productos y comprar en ${store}. Si buscás un artículo puntual, pasanos el código y te ayudamos a encontrarlo.` };
  }
  return { intent: 'unknown', handoff: false,
    text: `¡Hola! 💙 Gracias por escribir a Lupo Argentina. Contanos qué producto te interesa o si consultás por talles, precios, envíos o compras mayoristas.${whatsapp}` };
}

/** Avoid posting detailed customer info publicly or spamming unrelated comments. */
export function publicCommentFor(message, opts = {}) {
  const answer = answerFor(message, opts);
  if (answer.intent === 'unknown') return null;
  if (answer.intent === 'handoff') {
    return '¡Hola! 💙 Escribinos por mensaje privado para que nuestro equipo pueda revisar tu caso sin exponer tus datos.';
  }
  if (answer.intent === 'price' || answer.intent === 'stock' || answer.intent === 'size') {
    return '¡Hola! 💙 Escribinos por privado con el código del producto y te orientamos con la información correcta.';
  }
  if (answer.intent === 'wholesale') {
    return '¡Hola! 💙 Sí, vendemos por mayor. Escribinos por privado y te contamos las condiciones.';
  }
  if (answer.intent === 'shipping') {
    return '¡Hola! 💙 El costo y plazo dependen del destino. Escribinos por privado y te orientamos.';
  }
  return '¡Hola! 💙 Podés ver nuestros productos en https://lupo.ar. ¡Gracias por escribirnos!';
}

export function privateReplyFor(message, opts = {}) {
  const answer = answerFor(message, opts);
  if (answer.intent === 'unknown') return null;
  return `${answer.text}\n\nSi querés continuar, respondé este mensaje. 💙`;
}
