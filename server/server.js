"use strict";

require("dotenv").config();

const crypto = require("crypto");
const cors = require("cors");
const express = require("express");
const fs = require("fs");
const nodemailer = require("nodemailer");
const path = require("path");

const app = express();

/* -------------------------------------------------------------------------- */
/* File storage                                                               */
/* -------------------------------------------------------------------------- */

const DATA_DIRECTORY = path.join(__dirname, "data");
const ORDERS_FILE = path.join(DATA_DIRECTORY, "orders.json");

/* -------------------------------------------------------------------------- */
/* Environment configuration                                                  */
/* -------------------------------------------------------------------------- */

const PORT = Number(process.env.PORT || 3000);

const FRONTEND_URL =
  process.env.FRONTEND_URL || "http://127.0.0.1:5500";

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const SQUARE_LOCATION_ID = process.env.SQUARE_LOCATION_ID;

const SQUARE_ENVIRONMENT =
  process.env.SQUARE_ENVIRONMENT || "sandbox";

const SQUARE_WEBHOOK_SIGNATURE_KEY =
  process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;

const SQUARE_WEBHOOK_URL =
  process.env.SQUARE_WEBHOOK_URL;

const TICKET_PRICE_CENTS = Number(
  process.env.TICKET_PRICE_CENTS || 1000
);

const MAX_CAPACITY = Number(
  process.env.MAX_CAPACITY || 750
);

/*
 * Pending orders automatically release their reserved capacity after
 * 30 minutes if no successful payment webhook arrives.
 */
const PENDING_ORDER_MINUTES = Number(
  process.env.PENDING_ORDER_MINUTES || 30
);

const GMAIL_USER = process.env.GMAIL_USER;

/*
 * Google displays App Passwords with spaces. Removing whitespace here means
 * the .env value works whether it was pasted with or without spaces.
 */
const GMAIL_APP_PASSWORD = String(
  process.env.GMAIL_APP_PASSWORD || ""
).replace(/\s/g, "");

const EMAIL_FROM =
  process.env.EMAIL_FROM ||
  `Garba Night <${GMAIL_USER || ""}>`;

const SQUARE_API_BASE =
  SQUARE_ENVIRONMENT === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";

/* -------------------------------------------------------------------------- */
/* Email client                                                               */
/* -------------------------------------------------------------------------- */

const emailTransporter =
  GMAIL_USER && GMAIL_APP_PASSWORD
    ? nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: GMAIL_USER,
          pass: GMAIL_APP_PASSWORD,
        },
      })
    : null;

/* -------------------------------------------------------------------------- */
/* Order file helpers                                                         */
/* -------------------------------------------------------------------------- */

function ensureOrdersFile() {
  if (!fs.existsSync(DATA_DIRECTORY)) {
    fs.mkdirSync(DATA_DIRECTORY, {
      recursive: true,
    });
  }

  if (!fs.existsSync(ORDERS_FILE)) {
    fs.writeFileSync(ORDERS_FILE, "[]", "utf8");
  }
}

function readOrdersWithoutExpiring() {
  ensureOrdersFile();

  try {
    const fileContents = fs.readFileSync(
      ORDERS_FILE,
      "utf8"
    );

    if (!fileContents.trim()) {
      return [];
    }

    const parsed = JSON.parse(fileContents);

    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error(
      "Could not read orders.json:",
      error
    );

    return [];
  }
}

function writeOrders(orders) {
  ensureOrdersFile();

  const temporaryFile = `${ORDERS_FILE}.tmp`;

  fs.writeFileSync(
    temporaryFile,
    JSON.stringify(orders, null, 2),
    "utf8"
  );

  fs.renameSync(
    temporaryFile,
    ORDERS_FILE
  );
}

function expireOldPendingOrders() {
  const orders = readOrdersWithoutExpiring();

  const expirationTime =
    Date.now() -
    PENDING_ORDER_MINUTES * 60 * 1000;

  let changed = false;

  for (const order of orders) {
    if (order.status !== "PENDING") {
      continue;
    }

    const createdTime = new Date(
      order.createdAt
    ).getTime();

    if (
      Number.isFinite(createdTime) &&
      createdTime < expirationTime
    ) {
      order.status = "EXPIRED";
      order.paymentStatus = "EXPIRED";
      order.expiredAt = new Date().toISOString();
      order.updatedAt = new Date().toISOString();

      changed = true;
    }
  }

  if (changed) {
    writeOrders(orders);
  }

  return orders;
}

function readOrders() {
  return expireOldPendingOrders();
}

function updateOrder(localOrderId, changes) {
  const orders = readOrders();

  const orderIndex = orders.findIndex(
    (order) =>
      order.localOrderId === localOrderId
  );

  if (orderIndex === -1) {
    return null;
  }

  orders[orderIndex] = {
    ...orders[orderIndex],
    ...changes,
    updatedAt: new Date().toISOString(),
  };

  writeOrders(orders);

  return orders[orderIndex];
}

/* -------------------------------------------------------------------------- */
/* Capacity helpers                                                           */
/* -------------------------------------------------------------------------- */

function getPaidTicketCount() {
  return readOrders()
    .filter(
      (order) => order.status === "PAID"
    )
    .reduce(
      (total, order) =>
        total + Number(order.quantity || 0),
      0
    );
}

function getPendingTicketCount() {
  return readOrders()
    .filter(
      (order) => order.status === "PENDING"
    )
    .reduce(
      (total, order) =>
        total + Number(order.quantity || 0),
      0
    );
}

function getRemainingCapacity() {
  const reservedTickets =
    getPaidTicketCount() +
    getPendingTicketCount();

  return Math.max(
    MAX_CAPACITY - reservedTickets,
    0
  );
}

/* -------------------------------------------------------------------------- */
/* General helpers                                                            */
/* -------------------------------------------------------------------------- */

function cleanText(value, maxLength = 200) {
  return String(value || "")
    .trim()
    .replace(/[<>]/g, "")
    .slice(0, maxLength);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    email
  );
}

function normalizeCanadianPhone(phone) {
  const digits = String(phone || "").replace(
    /\D/g,
    ""
  );

  if (digits.length === 10) {
    return `+1${digits}`;
  }

  if (
    digits.length === 11 &&
    digits.startsWith("1")
  ) {
    return `+${digits}`;
  }

  return cleanText(phone, 30);
}

function formatCad(cents) {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
  }).format(Number(cents || 0) / 100);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function generateAdmissionCode() {
  const randomPart = crypto
    .randomBytes(5)
    .toString("hex")
    .toUpperCase();

  return `RAAS-${randomPart}`;
}

function validateCheckoutRequest(body) {
  const fullName = cleanText(
    body.fullName,
    100
  );

  const email = cleanText(
    body.email,
    150
  ).toLowerCase();

  const phone = normalizeCanadianPhone(
    body.phone
  );

  const notes = cleanText(
    body.notes,
    300
  );

  const quantity = Number(body.quantity);

  if (fullName.length < 2) {
    throw new Error(
      "Please enter the purchaser’s full legal name."
    );
  }

  if (!isValidEmail(email)) {
    throw new Error(
      "Please enter a valid email address."
    );
  }

  if (
    phone.replace(/\D/g, "").length < 10
  ) {
    throw new Error(
      "Please enter a valid phone number."
    );
  }

  if (
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > MAX_CAPACITY
  ) {
    throw new Error(
      `Ticket quantity must be a whole number between 1 and ${MAX_CAPACITY}.`
    );
  }

  return {
    fullName,
    email,
    phone,
    notes,
    quantity,
  };
}

/* -------------------------------------------------------------------------- */
/* Square webhook verification                                                */
/* -------------------------------------------------------------------------- */

function isValidSquareWebhookSignature(
  rawBody,
  providedSignature
) {
  if (
    !SQUARE_WEBHOOK_SIGNATURE_KEY ||
    !SQUARE_WEBHOOK_URL ||
    !providedSignature
  ) {
    return false;
  }

  const stringToSign =
    `${SQUARE_WEBHOOK_URL}${rawBody}`;

  const expectedSignature = crypto
    .createHmac(
      "sha256",
      SQUARE_WEBHOOK_SIGNATURE_KEY
    )
    .update(stringToSign, "utf8")
    .digest("base64");

  const expectedBuffer = Buffer.from(
    expectedSignature,
    "utf8"
  );

  const providedBuffer = Buffer.from(
    String(providedSignature),
    "utf8"
  );

  if (
    expectedBuffer.length !==
    providedBuffer.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    expectedBuffer,
    providedBuffer
  );
}

/* -------------------------------------------------------------------------- */
/* Confirmation email content                                                 */
/* -------------------------------------------------------------------------- */

function buildConfirmationEmailText(order) {
  return [
    "PAYMENT CONFIRMED — GARBA NIGHT 2026",
    "",
    `Purchaser: ${order.fullName}`,
    `Tickets purchased: ${order.quantity}`,
    `Amount paid: ${formatCad(
      order.paidAmountCents
    )}`,
    `Admission code: ${order.admissionCode}`,
    "",
    "ENTRY REQUIREMENTS",
    "",
    "Open this email live at event check-in.",
    "Screenshots, photographs and printed copies are not accepted.",
    "The purchaser named on the order must be present.",
    "Bring your driver’s licence or another government-issued photo ID so staff can confirm the purchaser’s identity.",
    "",
    "EVENT DETAILS",
    "Garba Night 2026",
    "Sunday, October 18, 2026",
    "7:00 PM – 11:00 PM",
    "Save Max Sports Centre",
    "1495 Sandalwood Pkwy E",
    "Brampton, ON L6R 0K2",
    "",
    `Order reference: ${order.localOrderId}`,
  ].join("\n");
}

function buildConfirmationEmailHtml(order) {
  const purchaserName = escapeHtml(
    order.fullName
  );

  const admissionCode = escapeHtml(
    order.admissionCode
  );

  const localOrderId = escapeHtml(
    order.localOrderId
  );

  return `
    <div style="
      margin:0;
      padding:32px 16px;
      background:#fff8f1;
      color:#2b1712;
      font-family:Arial,Helvetica,sans-serif;
    ">
      <div style="
        max-width:620px;
        margin:0 auto;
        overflow:hidden;
        background:#ffffff;
        border:1px solid #efd6c8;
        border-radius:20px;
      ">
        <div style="
          padding:30px 24px;
          background:#bd351f;
          color:#ffffff;
          text-align:center;
        ">
          <p style="
            margin:0 0 8px;
            font-size:13px;
            font-weight:700;
            letter-spacing:2px;
          ">
            PAYMENT CONFIRMED
          </p>

          <h1 style="
            margin:0;
            font-size:30px;
          ">
            Garba Night 2026
          </h1>
        </div>

        <div style="padding:30px;">
          <p style="
            margin-top:0;
            font-size:17px;
          ">
            Hello ${purchaserName},
          </p>

          <p style="
            line-height:1.65;
          ">
            Your payment has been confirmed.
            This email is your official Garba Night
            admission confirmation.
          </p>

          <div style="
            margin:24px 0;
            padding:24px;
            background:#fff3e6;
            border-radius:16px;
            text-align:center;
          ">
            <p style="
              margin:0 0 9px;
              color:#7b5549;
              font-size:13px;
              font-weight:700;
              letter-spacing:1.5px;
            ">
              ADMISSION CODE
            </p>

            <p style="
              margin:0;
              color:#bd351f;
              font-size:31px;
              font-weight:800;
              letter-spacing:2px;
            ">
              ${admissionCode}
            </p>
          </div>

          <table style="
            width:100%;
            border-collapse:collapse;
            font-size:16px;
          ">
            <tr>
              <td style="
                padding:10px 0;
                color:#765f57;
              ">
                Purchaser
              </td>

              <td style="
                padding:10px 0;
                text-align:right;
                font-weight:700;
              ">
                ${purchaserName}
              </td>
            </tr>

            <tr>
              <td style="
                padding:10px 0;
                color:#765f57;
              ">
                Tickets
              </td>

              <td style="
                padding:10px 0;
                text-align:right;
                font-weight:700;
              ">
                ${order.quantity}
              </td>
            </tr>

            <tr>
              <td style="
                padding:10px 0;
                color:#765f57;
              ">
                Amount paid
              </td>

              <td style="
                padding:10px 0;
                text-align:right;
                font-weight:700;
              ">
                ${formatCad(order.paidAmountCents)}
              </td>
            </tr>
          </table>

          <div style="
            margin:24px 0;
            border-top:1px solid #efd6c8;
          "></div>

          <h2 style="
            margin-bottom:12px;
            font-size:19px;
          ">
            Entry requirements
          </h2>

          <ul style="
            margin:0;
            padding-left:21px;
            line-height:1.75;
          ">
            <li>
              Open this email live at event check-in.
            </li>

            <li>
              Screenshots, photographs and printed
              copies are not accepted.
            </li>

            <li>
              The purchaser named on this order must
              be present.
            </li>

            <li>
              Bring your
              <strong>
                driver’s licence or another
                government-issued photo ID
              </strong>
              so staff can confirm the purchaser’s
              identity.
            </li>
          </ul>

          <div style="
            margin-top:24px;
            padding:18px;
            background:#faf7f5;
            border-radius:14px;
            line-height:1.65;
          ">
            <strong>
              Sunday, October 18, 2026
            </strong>

            <br>

            7:00 PM – 11:00 PM

            <br>

            Save Max Sports Centre

            <br>

            1495 Sandalwood Pkwy E,
            Brampton, ON L6R 0K2
          </div>

          <p style="
            margin:24px 0 0;
            color:#8c7770;
            font-size:12px;
          ">
            Order reference: ${localOrderId}
          </p>
        </div>
      </div>
    </div>
  `;
}

/* -------------------------------------------------------------------------- */
/* Email delivery                                                             */
/* -------------------------------------------------------------------------- */

/*
 * Claims the email before sending it. This prevents repeated Square webhook
 * deliveries from deliberately sending duplicate confirmation emails.
 */
function claimEmailDelivery(localOrderId) {
  const orders = readOrders();

  const index = orders.findIndex(
    (order) =>
      order.localOrderId === localOrderId
  );

  if (index === -1) {
    return null;
  }

  const order = orders[index];

  if (
    order.status !== "PAID" ||
    order.emailStatus === "SENT" ||
    order.emailStatus === "SENDING"
  ) {
    return null;
  }

  order.emailStatus = "SENDING";
  order.emailAttemptedAt =
    new Date().toISOString();
  order.updatedAt =
    new Date().toISOString();

  orders[index] = order;
  writeOrders(orders);

  return order;
}

async function sendConfirmationEmail(
  localOrderId
) {
  const order = claimEmailDelivery(
    localOrderId
  );

  if (!order) {
    return;
  }

  try {
    const result =
      await emailTransporter.sendMail({
        from: EMAIL_FROM,

        to: order.email,

        subject:
          `Payment Confirmed — Garba Night 2026 — ${order.admissionCode}`,

        text:
          buildConfirmationEmailText(order),

        html:
          buildConfirmationEmailHtml(order),
      });

    updateOrder(localOrderId, {
      emailStatus: "SENT",
      emailMessageId: result.messageId,
      emailSentAt: new Date().toISOString(),
      emailError: null,
    });

    console.log(
      "Confirmation email sent:",
      order.email
    );
  } catch (error) {
    updateOrder(localOrderId, {
      emailStatus: "FAILED",
      emailError: cleanText(
        error.message,
        500
      ),
    });

    console.error(
      "Confirmation email failed:",
      error.message
    );
  }
}

/* -------------------------------------------------------------------------- */
/* CORS                                                                       */
/* -------------------------------------------------------------------------- */

app.use(
  cors({
    origin: [
      FRONTEND_URL,
      "http://127.0.0.1:5500",
      "http://localhost:5500",
    ],
  })
);

/* -------------------------------------------------------------------------- */
/* Square webhook                                                             */
/* -------------------------------------------------------------------------- */

/*
 * This route must appear before express.json().
 * Square signature verification requires the original raw request body.
 */
app.post(
  "/webhook",

  express.raw({
    type: "application/json",
  }),

  (request, response) => {
    try {
      const rawBody = request.body.toString(
        "utf8"
      );

      const signature = request.get(
        "x-square-hmacsha256-signature"
      );

      if (
        !isValidSquareWebhookSignature(
          rawBody,
          signature
        )
      ) {
        console.error(
          "Rejected webhook: invalid Square signature."
        );

        return response
          .status(403)
          .send("Invalid signature");
      }

      const event = JSON.parse(rawBody);

      console.log("");
      console.log("Square webhook received");
      console.log("Event type:", event.type);
      console.log("Event ID:", event.event_id);

      if (event.type !== "payment.updated") {
        return response
          .status(200)
          .send("Event ignored");
      }

      const payment =
        event?.data?.object?.payment;

      if (!payment) {
        return response
          .status(200)
          .send("No payment object");
      }

      console.log("Payment ID:", payment.id);
      console.log(
        "Payment status:",
        payment.status
      );
      console.log(
        "Square order ID:",
        payment.order_id
      );

      if (payment.status !== "COMPLETED") {
        return response
          .status(200)
          .send("Payment not completed");
      }

      const squareOrderId =
        payment.order_id;

      const orders = readOrders();

      const orderIndex = orders.findIndex(
        (order) =>
          order.squareOrderId ===
          squareOrderId
      );

      if (orderIndex === -1) {
        console.error(
          "Completed payment has no matching local order:",
          squareOrderId
        );

        return response
          .status(200)
          .send("Unknown order");
      }

      const order = orders[orderIndex];

      /*
       * Square might deliver the same event more than once.
       */
      if (order.status === "PAID") {
        response
          .status(200)
          .send("Already processed");

        if (order.emailStatus !== "SENT") {
          setImmediate(() => {
            void sendConfirmationEmail(
              order.localOrderId
            );
          });
        }

        return;
      }

      const paidAmountCents = Number(
        payment.amount_money?.amount
      );

      const paidCurrency =
        payment.amount_money?.currency;

      if (
        paidAmountCents !==
        Number(order.expectedAmountCents)
      ) {
        order.status = "MANUAL_REVIEW";
        order.reviewReason =
          "PAYMENT_AMOUNT_MISMATCH";
        order.paymentId = payment.id;
        order.webhookEventId =
          event.event_id;
        order.updatedAt =
          new Date().toISOString();

        orders[orderIndex] = order;
        writeOrders(orders);

        return response
          .status(200)
          .send("Manual review required");
      }

      if (paidCurrency !== "CAD") {
        order.status = "MANUAL_REVIEW";
        order.reviewReason =
          "PAYMENT_CURRENCY_MISMATCH";
        order.paymentId = payment.id;
        order.webhookEventId =
          event.event_id;
        order.updatedAt =
          new Date().toISOString();

        orders[orderIndex] = order;
        writeOrders(orders);

        return response
          .status(200)
          .send("Manual review required");
      }

      /*
       * Payment successfully matched and verified.
       */
      order.status = "PAID";
      order.paymentStatus = "COMPLETED";
      order.paymentId = payment.id;
      order.paidAmountCents =
        paidAmountCents;
      order.currency = paidCurrency;

      order.admissionCode =
        order.admissionCode ||
        generateAdmissionCode();

      order.webhookEventId =
        event.event_id;

      order.paidAt =
        new Date().toISOString();

      order.updatedAt =
        new Date().toISOString();

      order.emailStatus =
        order.emailStatus || "NOT_SENT";

      order.checkedIn = false;

      orders[orderIndex] = order;
      writeOrders(orders);

      console.log("");
      console.log("GARBA ORDER VERIFIED");
      console.log(
        "Purchaser:",
        order.fullName
      );
      console.log("Email:", order.email);
      console.log(
        "Tickets:",
        order.quantity
      );
      console.log(
        "Paid:",
        formatCad(paidAmountCents)
      );
      console.log(
        "Admission code:",
        order.admissionCode
      );
      console.log(
        "Paid tickets:",
        getPaidTicketCount()
      );
      console.log(
        "Remaining capacity:",
        getRemainingCapacity()
      );
      console.log("");

      /*
       * Respond immediately so Square knows the webhook was received.
       */
      response
        .status(200)
        .send("Payment verified");

      /*
       * Send exactly one event confirmation email after payment verification.
       */
      setImmediate(() => {
        void sendConfirmationEmail(
          order.localOrderId
        );
      });
    } catch (error) {
      console.error(
        "Webhook processing failed:",
        error
      );

      response.sendStatus(400);
    }
  }
);

/*
 * Normal JSON middleware must remain below the raw webhook route.
 */
app.use(express.json());

/* -------------------------------------------------------------------------- */
/* Environment validation                                                     */
/* -------------------------------------------------------------------------- */

function validateEnvironment() {
  const requiredValues = {
    SQUARE_ACCESS_TOKEN,
    SQUARE_LOCATION_ID,
    SQUARE_WEBHOOK_SIGNATURE_KEY,
    SQUARE_WEBHOOK_URL,
    GMAIL_USER,
    GMAIL_APP_PASSWORD,
  };

  const missing = Object.entries(
    requiredValues
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `Missing environment variables: ${missing.join(
        ", "
      )}`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Health check                                                               */
/* -------------------------------------------------------------------------- */

app.get("/health", (request, response) => {
  response.json({
    success: true,
    message:
      "Garba payment server is running.",
    environment: SQUARE_ENVIRONMENT,
    ticketPriceCents: TICKET_PRICE_CENTS,
    maximumCapacity: MAX_CAPACITY,
    paidTickets: getPaidTicketCount(),
    pendingTickets:
      getPendingTicketCount(),
    remainingCapacity:
      getRemainingCapacity(),
    webhookConfigured: Boolean(
      SQUARE_WEBHOOK_SIGNATURE_KEY &&
        SQUARE_WEBHOOK_URL
    ),
    emailConfigured: Boolean(
      emailTransporter
    ),
  });
});

/* -------------------------------------------------------------------------- */
/* Create Square checkout                                                     */
/* -------------------------------------------------------------------------- */

app.post(
  "/api/create-checkout",

  async (request, response) => {
    try {
      const customer =
        validateCheckoutRequest(
          request.body
        );

      const remainingCapacity =
        getRemainingCapacity();

      if (
        customer.quantity >
        remainingCapacity
      ) {
        return response
          .status(409)
          .json({
            success: false,

            message:
              remainingCapacity === 0
                ? "Garba Night is currently sold out."
                : `Only ${remainingCapacity} ticket(s) are currently available.`,
          });
      }

      const totalAmountCents =
        customer.quantity *
        TICKET_PRICE_CENTS;

      const localOrderId =
        `GARBA-${Date.now()}-${crypto
          .randomBytes(3)
          .toString("hex")
          .toUpperCase()}`;

      const squareRequest = {
        idempotency_key:
          crypto.randomUUID(),

        description:
          `${customer.quantity} Garba ticket(s) for ${customer.fullName}`,

        quick_pay: {
          name:
            `Garba Night — ${customer.quantity} Ticket${
              customer.quantity === 1
                ? ""
                : "s"
            }`,

          price_money: {
            amount: totalAmountCents,
            currency: "CAD",
          },

          location_id:
            SQUARE_LOCATION_ID,
        },

        checkout_options: {
          redirect_url:
            `${FRONTEND_URL}/index.html?payment=return`,

          ask_for_shipping_address:
            false,

          enable_coupon: false,
          enable_loyalty: false,
        },

        pre_populated_data: {
          buyer_email:
            customer.email,

          buyer_phone_number:
            customer.phone,
        },

        payment_note:
          localOrderId,
      };

      const squareResponse =
        await fetch(
          `${SQUARE_API_BASE}/v2/online-checkout/payment-links`,

          {
            method: "POST",

            headers: {
              Authorization:
                `Bearer ${SQUARE_ACCESS_TOKEN}`,

              "Content-Type":
                "application/json",

              "Square-Version":
                "2026-07-15",
            },

            body: JSON.stringify(
              squareRequest
            ),
          }
        );

      const squareData =
        await squareResponse.json();

      if (!squareResponse.ok) {
        console.error(
          "Square checkout error:",
          JSON.stringify(
            squareData,
            null,
            2
          )
        );

        return response
          .status(502)
          .json({
            success: false,

            message:
              squareData.errors?.[0]
                ?.detail ||
              squareData.errors?.[0]
                ?.code ||
              "Square could not create the checkout.",
          });
      }

      const paymentLink =
        squareData.payment_link;

      if (
        !paymentLink?.url ||
        !paymentLink?.order_id
      ) {
        return response
          .status(502)
          .json({
            success: false,
            message:
              "Square did not return a valid checkout link.",
          });
      }

      const now =
        new Date().toISOString();

      const orders = readOrders();

      orders.push({
        localOrderId,

        squareOrderId:
          paymentLink.order_id,

        fullName:
          customer.fullName,

        email:
          customer.email,

        phone:
          customer.phone,

        notes:
          customer.notes,

        quantity:
          customer.quantity,

        ticketPriceCents:
          TICKET_PRICE_CENTS,

        expectedAmountCents:
          totalAmountCents,

        currency: "CAD",

        status: "PENDING",

        paymentStatus: "PENDING",

        paymentId: null,

        admissionCode: null,

        emailStatus: "NOT_SENT",

        emailMessageId: null,

        emailAttemptedAt: null,

        emailSentAt: null,

        emailError: null,

        checkedIn: false,

        reviewReason: null,

        createdAt: now,

        updatedAt: now,

        paidAt: null,

        expiredAt: null,
      });

      writeOrders(orders);

      console.log("");
      console.log(
        "Square checkout created"
      );
      console.log(
        "Local order ID:",
        localOrderId
      );
      console.log(
        "Square order ID:",
        paymentLink.order_id
      );
      console.log(
        "Purchaser:",
        customer.fullName
      );
      console.log(
        "Quantity:",
        customer.quantity
      );
      console.log(
        "Total cents:",
        totalAmountCents
      );
      console.log(
        "Order saved to orders.json"
      );
      console.log("");

      response.json({
        success: true,

        checkoutUrl:
          paymentLink.url,

        squareOrderId:
          paymentLink.order_id,

        localOrderId,

        quantity:
          customer.quantity,

        totalAmountCents,

        remainingCapacity:
          getRemainingCapacity(),
      });
    } catch (error) {
      console.error(
        "Checkout creation failed:",
        error
      );

      response
        .status(400)
        .json({
          success: false,

          message:
            error.message ||
            "Unable to create checkout.",
        });
    }
  }
);

/* -------------------------------------------------------------------------- */
/* View safe order status                                                     */
/* -------------------------------------------------------------------------- */

app.get(
  "/api/order/:localOrderId",

  (request, response) => {
    const localOrderId =
      cleanText(
        request.params.localOrderId,
        100
      );

    const order = readOrders().find(
      (item) =>
        item.localOrderId ===
        localOrderId
    );

    if (!order) {
      return response
        .status(404)
        .json({
          success: false,
          message: "Order not found.",
        });
    }

    response.json({
      success: true,

      order: {
        localOrderId:
          order.localOrderId,

        status:
          order.status,

        quantity:
          order.quantity,

        admissionCode:
          order.status === "PAID"
            ? order.admissionCode
            : null,

        emailStatus:
          order.emailStatus,
      },
    });
  }
);

/* -------------------------------------------------------------------------- */
/* Start server                                                               */
/* -------------------------------------------------------------------------- */

try {
  ensureOrdersFile();
  validateEnvironment();

  app.listen(PORT, () => {
    console.log("");
    console.log(
      "Garba payment backend started"
    );
    console.log(
      `Server: http://localhost:${PORT}`
    );
    console.log(
      `Health check: http://localhost:${PORT}/health`
    );
    console.log(
      `Square environment: ${SQUARE_ENVIRONMENT}`
    );
    console.log(
      `Webhook route: ${SQUARE_WEBHOOK_URL}`
    );
    console.log(
      `Orders file: ${ORDERS_FILE}`
    );
    console.log(
      `Paid tickets: ${getPaidTicketCount()}`
    );
    console.log(
      `Remaining capacity: ${getRemainingCapacity()}`
    );
    console.log(
      "Email notifications: configured"
    );
    console.log("");
  });
} catch (error) {
  console.error(
    "Server could not start:",
    error.message
  );

  process.exit(1);
}