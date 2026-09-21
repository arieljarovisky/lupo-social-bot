# Lupo Social Bot — MVP 0.1

Proyecto propio en **Node.js 22 + Express**, sin Manychat ni IA paga, para **DM de Instagram, Messenger y comentarios públicos**. Responde por reglas y permite que un humano continúe en la bandeja de Meta. Está diseñado para probar en modo simulación primero: `DRY_RUN=true` por defecto.

## Qué funciona en este MVP

- `GET /webhook`: handshake de verificación de Meta.
- `POST /webhook`: verifica firma HMAC-SHA256 sobre bytes originales del payload.
- Recibe DMs y comentarios de Instagram (`object=instagram`, `messaging` / `changes.comments`); recibe Messenger y comentarios de Facebook (`object=page`, `messaging` / `changes.feed`). Ignora ecos, respuestas anidadas y cuentas no configuradas.
- Intenciones: mayoristas, talles, stock, precios, envíos, compras, reclamos.
- Respuestas públicas breves que no publican información personal, precios de variantes ni stock sin verificar.
- Respuesta privada opcional **solo para comentario IG**, `IG_PRIVATE_REPLIES=true`: una solicitud por comentario, sin reintento automático; requiere permisos y respetar los límites de Meta. Se desactiva por defecto.
- Reclamos y preguntas no entendidas: mensaje de derivación al humano y **pausa del bot por 24 h** para esa conversación *en memoria*. Debés supervisar la bandeja de Meta: el software NO asigna agentes ni envía notificaciones externas.
- Dedupe básico durante 48 h en memoria; sin base de datos ni cola persistente todavía.

**No incluido aún**: IA generativa, consulta de productos/stock en tiempo real, panel React, carga de conversaciones históricas, almacenamiento de leads, WhatsApp API, reintentos durables, soporte de múltiples negocios ni activación en cuentas reales. Los campos `TIENDANUBE_*` son reservas para la siguiente etapa; todavía NO realizan consultas.

## 1. Requisitos

- Node.js >= 22, npm, cuenta Instagram profesional y página comercial de Facebook para Messenger.
- Meta App autorizada con los productos y permisos correspondientes y control administrativo sobre los activos.
- Para conectar Instagram en este proyecto, usar **Instagram API with Instagram Login**: el token de IG NO es el token de Página que se obtiene por Facebook Login. Para Facebook Messenger se usa Page Access Token.
- HTTPS público válido para el webhook (en desarrollo, un túnel HTTPS de confianza que reenvíe a `localhost:3000`; puede ser un plan gratuito, pero consultá sus condiciones).
- Permisos de Instagram que pueden necesitarse: `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments`. Permisos de Facebook según funciones y flujo: `pages_messaging`, `pages_manage_engagement`, `pages_read_engagement`, `pages_manage_metadata` y `pages_show_list` si es necesario listar páginas. La disponibilidad de acceso a clientes ajenos a roles de prueba puede exigir App Review/Advanced Access, verificaciones empresariales y app en modo Live: revisar el dashboard concreto.

Documentación de referencia:
- Meta, Instagram API en su workspace oficial de Postman: https://www.postman.com/meta/instagram/overview
- Meta, Messenger Platform API: https://www.postman.com/meta/messenger-platform-api/collection/iyp204x/messenger-platform-api
- Meta, webhooks: https://developers.facebook.com/docs/graph-api/webhooks/getting-started
- Tiendanube, API: https://tiendanube.dev/api/getting-started
- Tiendanube, OAuth: https://tiendanube.dev/es-AR/api/authentication

## 2. Instalación

```bash
npm install
cp .env.example .env
```

En Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Editar `.env`. Para el simulador, crear un `SIMULATOR_TOKEN` aleatorio distinto del token de Meta. Mantener `DRY_RUN=true` en las primeras pruebas. Elegí `META_VERIFY_TOKEN` aleatorio y copiá desde Meta el `META_APP_SECRET` real; nunca compartas ni publiques secretos o tokens. Ingresá `IG_USER_ID`, `IG_ACCESS_TOKEN`, `FB_PAGE_ID`, `FB_PAGE_ACCESS_TOKEN`, `IG_USERNAME` (opcional, recomendado para evitar respuestas a comentarios propios). El número de WhatsApp es opcional y se usa solo para generar un enlace; **no envía mensajes por WhatsApp**.

```bash
npm start
```

Visitar `http://127.0.0.1:3000/health` para comprobar el estado.

### Probar respuestas sin conectar Meta

```bash
curl -X POST http://127.0.0.1:3000/simulate \
  -H 'Content-Type: application/json' \
  -H 'x-simulator-token: TU_SIMULATOR_TOKEN' \
  -d '{"text":"Hola, ¿precio del boxer y talle G?"}'
```

El simulador requiere un token propio además de una conexión local. Un túnel hacia localhost también puede reenviar esa ruta: **no expongas el token del simulador ni los archivos de configuración**; publicá únicamente el webhook o usá un proxy que filtre rutas. El servidor escucha por defecto en 127.0.0.1, apropiado para el desarrollo con túnel local. Para hosting, configurá el binding y el proxy de forma segura.

## 3. Meta Developers: conexión real

1. Crear la app en https://developers.facebook.com/apps/ y seleccionar los productos/casos de uso pertinentes para Messenger y la API de Instagram. Confirmar que Instagram sea profesional.
2. En el producto Webhooks, definir la **Callback URL** `https://TU-DOMINIO-HTTPS/webhook` y el mismo valor de `META_VERIFY_TOKEN` que en `.env`. Suscribirse a los campos `messages`/`comments` de Instagram y `messages`/`feed` de Página según estén disponibles en la configuración. Además suscribir la app a la Página cuando el dashboard o API lo indique.
3. Obtener **dos juegos distintos** de credenciales: Instagram Login (`IG_USER_ID`, `IG_ACCESS_TOKEN`) y Page Access Token (`FB_PAGE_ID`, `FB_PAGE_ACCESS_TOKEN`). Los permisos de las funciones que vayas a utilizar deben estar concedidos.
4. Probar con cuentas y roles habilitados, aún en `DRY_RUN=true`, y mirar la consola. Luego probar un mensaje de un usuario autorizado, habilitar `DRY_RUN=false` y verificar una sola respuesta antes de ampliar el alcance.
5. **Revisión de app / acceso avanzado**: según tu modalidad y tipo de usuarios, Meta puede limitar el acceso a usuarios con rol durante el desarrollo. No asumir que un token de prueba permite atender a todos los seguidores. Confirmar los requisitos en App Dashboard antes de producción.

**Ventanas de mensajes:** responder únicamente a mensajes entrantes válidos dentro de la ventana de la plataforma, no usar este proyecto para campañas masivas. La respuesta privada a un comentario de IG es una interacción especial: suele permitirse una vez por comentario y durante una ventana limitada; no habilita libremente una conversación de seguimiento hasta que el usuario contesta. Si la API la rechaza, el bot solo deja respuesta pública. Las reglas exactas pueden cambiar: revisar documentación de Meta al activar la función.

## 4. Tests

```bash
npm test
```

Los tests prueban motor de reglas, HMAC, parsing de eventos, deduplicación, pausa humana, diferencias entre rutas de comentarios, respuesta privada opcional y modo simulación. También se testea el host y el header Bearer con `fetch` simulado. **No** se han realizado pruebas end-to-end con Meta: requieren autorización y tokens propios.

## 5. Antes de pasar a producción

Este repositorio es una base de desarrollo, **no un servicio 24/7 endurecido**. Cambios obligatorios para volumen real:

- Sustituir `Map` en memoria por Redis o base de datos y agregar cola durable (p. ej. BullMQ) para guardar eventos **antes** del HTTP 200. De lo contrario, un fallo de proceso tras confirmar el webhook puede perder mensajes; un reinicio borra dedupe y pausas humanas.
- Serializar respuestas por conversación y gestionar correctamente mensajes simultáneos para evitar respuestas fuera de orden y duplicados; agregar idempotencia persistida y política de errores/reintentos por tipo de respuesta (no reintentar la respuesta privada IG sin comprobar si se consumió).
- Almacenar solo datos necesarios, definir retención, restringir acceso a logs, rotar tokens, implementar observabilidad y rate limits.
- Revisar con Meta las políticas, permisos y modalidades vigentes, incluidas ventanas de mensajería y límites por comentario.
- Confirmar dónde se controla el hilo por humanos y cómo se detiene el bot desde el panel; hoy la pausa de 24 h se activa únicamente con consultas clasificadas como derivación.
- Integrar Tiendanube con OAuth y scope mínimo `read_products`, buscar SKU/variantes, validar stock por talle/color y usar la URL real del producto. No inventar medidas ni prometer precios que no fueron leídos de la tienda.

## Estructura

```text
lupo-social-bot/
  .env.example         # plantilla, sin secretos reales
  .gitignore
  package.json
  README.md
  src/
    server.js          # servidor Express y webhooks
    meta.js            # firma, normalización y llamadas Graph API
    replies.js         # reglas comerciales Lupo
    bot.js             # orquestación, dedupe y pausa humana
  test/
    bot.test.js
```
