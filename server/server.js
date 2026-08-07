"use strict";

require("dotenv").config();

const crypto = require("crypto");
const cors = require("cors");
const express = require("express");
const fs = require("fs");
const nodemailer = require("nodemailer");
const path = require("path");

const app = express();


/* ==========================================================================
   FILE STORAGE
   ========================================================================== */

const DATA_DIRECTORY =
  path.join(
    __dirname,
    "data"
  );

const ORDERS_FILE =
  path.join(
    DATA_DIRECTORY,
    "orders.json"
  );


/* ==========================================================================
   ENVIRONMENT
   ========================================================================== */

const PORT =
  Number(
    process.env.PORT || 3000
  );

const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  "http://127.0.0.1:5500";

const SQUARE_ACCESS_TOKEN =
  process.env.SQUARE_ACCESS_TOKEN;

const SQUARE_LOCATION_ID =
  process.env.SQUARE_LOCATION_ID;

const SQUARE_ENVIRONMENT =
  process.env.SQUARE_ENVIRONMENT ||
  "sandbox";

const SQUARE_WEBHOOK_SIGNATURE_KEY =
  process.env
    .SQUARE_WEBHOOK_SIGNATURE_KEY;

const SQUARE_WEBHOOK_URL =
  process.env.SQUARE_WEBHOOK_URL;

const TICKET_PRICE_CENTS =
  Number(
    process.env.TICKET_PRICE_CENTS ||
    1100
  );

const MAX_CAPACITY =
  Number(
    process.env.MAX_CAPACITY ||
    1000
  );

const PENDING_ORDER_MINUTES =
  Number(
    process.env
      .PENDING_ORDER_MINUTES ||
    30
  );


/* --------------------------------------------------------------------------
   EMAIL
   -------------------------------------------------------------------------- */

const GMAIL_USER =
  process.env.GMAIL_USER;

const GMAIL_APP_PASSWORD =
  String(
    process.env
      .GMAIL_APP_PASSWORD ||
    ""
  ).replace(
    /\s/g,
    ""
  );

const EMAIL_FROM =
  process.env.EMAIL_FROM ||
  `Garba Night <${GMAIL_USER || ""}>`;


/* --------------------------------------------------------------------------
   GOOGLE SHEETS
   -------------------------------------------------------------------------- */

const GOOGLE_SHEETS_WEBHOOK_URL =
  process.env
    .GOOGLE_SHEETS_WEBHOOK_URL;

const GOOGLE_SHEETS_SECRET =
  process.env
    .GOOGLE_SHEETS_SECRET;


/* --------------------------------------------------------------------------
   SQUARE API
   -------------------------------------------------------------------------- */

const SQUARE_API_BASE =
  SQUARE_ENVIRONMENT ===
  "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";


/* ==========================================================================
   EMAIL CLIENT
   ========================================================================== */

const emailTransporter =
  GMAIL_USER &&
  GMAIL_APP_PASSWORD
    ? nodemailer.createTransport({
        service: "gmail",

        auth: {
          user: GMAIL_USER,
          pass: GMAIL_APP_PASSWORD
        }
      })
    : null;


/* ==========================================================================
   ORDER FILE HELPERS
   ========================================================================== */

function ensureOrdersFile() {
  if (
    !fs.existsSync(
      DATA_DIRECTORY
    )
  ) {
    fs.mkdirSync(
      DATA_DIRECTORY,
      {
        recursive: true
      }
    );
  }


  if (
    !fs.existsSync(
      ORDERS_FILE
    )
  ) {
    fs.writeFileSync(
      ORDERS_FILE,
      "[]",
      "utf8"
    );
  }
}


function readOrdersWithoutExpiring() {
  ensureOrdersFile();

  try {
    const contents =
      fs.readFileSync(
        ORDERS_FILE,
        "utf8"
      );

    if (!contents.trim()) {
      return [];
    }

    const parsed =
      JSON.parse(
        contents
      );

    return Array.isArray(
      parsed
    )
      ? parsed
      : [];

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

  const temporaryFile =
    `${ORDERS_FILE}.tmp`;

  fs.writeFileSync(
    temporaryFile,
    JSON.stringify(
      orders,
      null,
      2
    ),
    "utf8"
  );

  fs.renameSync(
    temporaryFile,
    ORDERS_FILE
  );
}


function expireOldPendingOrders() {
  const orders =
    readOrdersWithoutExpiring();

  const expirationTime =
    Date.now() -
    PENDING_ORDER_MINUTES *
      60 *
      1000;

  let changed = false;


  for (
    const order
    of orders
  ) {
    if (
      order.status !==
      "PENDING"
    ) {
      continue;
    }


    const createdTime =
      new Date(
        order.createdAt
      ).getTime();


    if (
      Number.isFinite(
        createdTime
      ) &&
      createdTime <
        expirationTime
    ) {
      order.status =
        "EXPIRED";

      order.paymentStatus =
        "EXPIRED";

      order.expiredAt =
        new Date()
          .toISOString();

      order.updatedAt =
        new Date()
          .toISOString();

      changed = true;
    }
  }


  if (changed) {
    writeOrders(
      orders
    );
  }

  return orders;
}


function readOrders() {
  return expireOldPendingOrders();
}


function updateOrder(
  localOrderId,
  changes
) {
  const orders =
    readOrders();

  const index =
    orders.findIndex(
      (order) =>
        order.localOrderId ===
        localOrderId
    );

  if (index === -1) {
    return null;
  }


  orders[index] = {
    ...orders[index],
    ...changes,

    updatedAt:
      new Date()
        .toISOString()
  };


  writeOrders(
    orders
  );

  return orders[index];
}


/* ==========================================================================
   CAPACITY
   ========================================================================== */

function getPaidTicketCount() {
  return readOrders()
    .filter(
      (order) =>
        order.status ===
        "PAID"
    )
    .reduce(
      (
        total,
        order
      ) =>
        total +
        Number(
          order.quantity ||
          0
        ),

      0
    );
}


function getPendingTicketCount() {
  return readOrders()
    .filter(
      (order) =>
        order.status ===
        "PENDING"
    )
    .reduce(
      (
        total,
        order
      ) =>
        total +
        Number(
          order.quantity ||
          0
        ),

      0
    );
}


function getRemainingCapacity() {
  return Math.max(
    MAX_CAPACITY -
      getPaidTicketCount() -
      getPendingTicketCount(),

    0
  );
}


/* ==========================================================================
   GENERAL HELPERS
   ========================================================================== */

function cleanText(
  value,
  maxLength = 200
) {
  return String(
    value || ""
  )
    .trim()
    .replace(
      /[<>]/g,
      ""
    )
    .slice(
      0,
      maxLength
    );
}


function isValidEmail(
  email
) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    email
  );
}


function normalizeCanadianPhone(
  phone
) {
  const digits =
    String(
      phone || ""
    ).replace(
      /\D/g,
      ""
    );


  if (
    digits.length === 10
  ) {
    return `+1${digits}`;
  }


  if (
    digits.length === 11 &&
    digits.startsWith(
      "1"
    )
  ) {
    return `+${digits}`;
  }


  return cleanText(
    phone,
    30
  );
}


function formatCad(
  cents
) {
  return new Intl
    .NumberFormat(
      "en-CA",
      {
        style:
          "currency",

        currency:
          "CAD"
      }
    )
    .format(
      Number(
        cents || 0
      ) / 100
    );
}


function escapeHtml(
  value
) {
  return String(
    value || ""
  )
    .replaceAll(
      "&",
      "&amp;"
    )
    .replaceAll(
      "<",
      "&lt;"
    )
    .replaceAll(
      ">",
      "&gt;"
    )
    .replaceAll(
      '"',
      "&quot;"
    )
    .replaceAll(
      "'",
      "&#039;"
    );
}


function generateAdmissionCode() {
  const randomPart =
    crypto
      .randomBytes(5)
      .toString("hex")
      .toUpperCase();

  return `RAAS-${randomPart}`;
}


/* ==========================================================================
   CHECKOUT VALIDATION
   ========================================================================== */

function validateCheckoutRequest(
  body
) {
  const fullName =
    cleanText(
      body.fullName,
      100
    );

  const email =
    cleanText(
      body.email,
      150
    ).toLowerCase();

  const phone =
    normalizeCanadianPhone(
      body.phone
    );

  const quantity =
    Number(
      body.quantity
    );


  /*
   * This MUST only be true when the
   * user actively checked the box.
   */
  const marketingConsent =
    body.marketingConsent ===
    true;


  if (
    fullName.length < 2
  ) {
    throw new Error(
      "Please enter the purchaser’s full legal name."
    );
  }


  if (
    !isValidEmail(
      email
    )
  ) {
    throw new Error(
      "Please enter a valid email address."
    );
  }


  if (
    phone
      .replace(
        /\D/g,
        ""
      )
      .length <
    10
  ) {
    throw new Error(
      "Please enter a valid phone number."
    );
  }


  if (
    !Number.isInteger(
      quantity
    ) ||
    quantity < 1 ||
    quantity >
      MAX_CAPACITY
  ) {
    throw new Error(
      `Ticket quantity must be a whole number between 1 and ${MAX_CAPACITY}.`
    );
  }


  return {
    fullName,
    email,
    phone,
    quantity,
    marketingConsent
  };
}


/* ==========================================================================
   SQUARE WEBHOOK SIGNATURE
   ========================================================================== */

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


  const expectedSignature =
    crypto
      .createHmac(
        "sha256",
        SQUARE_WEBHOOK_SIGNATURE_KEY
      )
      .update(
        stringToSign,
        "utf8"
      )
      .digest(
        "base64"
      );


  const expectedBuffer =
    Buffer.from(
      expectedSignature,
      "utf8"
    );

  const providedBuffer =
    Buffer.from(
      String(
        providedSignature
      ),
      "utf8"
    );


  if (
    expectedBuffer.length !==
    providedBuffer.length
  ) {
    return false;
  }


  return crypto
    .timingSafeEqual(
      expectedBuffer,
      providedBuffer
    );
}


/* ==========================================================================
   GOOGLE SHEETS — PAID ORDERS ONLY
   ========================================================================== */

async function savePaidOrderToGoogleSheet(
  localOrderId
) {
  const orders =
    readOrders();

  const index =
    orders.findIndex(
      (order) =>
        order.localOrderId ===
        localOrderId
    );


  if (
    index === -1
  ) {
    return;
  }


  const order =
    orders[index];


  /*
   * THIS IS THE IMPORTANT RULE:
   *
   * Do not send anything to Google Sheets
   * unless Square payment has already been
   * verified COMPLETED.
   */
  if (
    order.status !==
      "PAID" ||
    order.paymentStatus !==
      "COMPLETED"
  ) {
    console.log(
      "Sheets skipped — order is not paid:",
      localOrderId
    );

    return;
  }


  /*
   * Don't repeatedly send if it already worked.
   */
  if (
    order.sheetStatus ===
    "SAVED"
  ) {
    return;
  }


  if (
    !GOOGLE_SHEETS_WEBHOOK_URL ||
    !GOOGLE_SHEETS_SECRET
  ) {
    console.error(
      "Google Sheets is not configured."
    );

    updateOrder(
      localOrderId,
      {
        sheetStatus:
          "NOT_CONFIGURED"
      }
    );

    return;
  }


  updateOrder(
    localOrderId,
    {
      sheetStatus:
        "SENDING",

      sheetAttemptedAt:
        new Date()
          .toISOString()
    }
  );


  try {
    const response =
      await fetch(
        GOOGLE_SHEETS_WEBHOOK_URL,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "text/plain;charset=utf-8"
          },

          body:
            JSON.stringify({
              secret:
                GOOGLE_SHEETS_SECRET,

              status:
                order.status,

              paymentStatus:
                order.paymentStatus,

              admissionCode:
                order.admissionCode,

              fullName:
                order.fullName,

              email:
                order.email,

              phone:
                order.phone,

              quantity:
                order.quantity,

              paidAmount:
                Number(
                  order.paidAmountCents ||
                  0
                ) / 100,

              currency:
                order.currency,

              marketingConsent:
                Boolean(
                  order.marketingConsent
                ),

              marketingConsentTimestamp:
                order
                  .marketingConsentTimestamp ||
                "",

              marketingConsentSource:
                order
                  .marketingConsentSource ||
                "",

              paidAt:
                order.paidAt,

              localOrderId:
                order.localOrderId,

              squareOrderId:
                order.squareOrderId,

              paymentId:
                order.paymentId
            })
        }
      );


    const text =
      await response.text();


    let result = {};

    try {
      result =
        JSON.parse(
          text
        );
    } catch {
      result = {
        success:
          response.ok
      };
    }


    if (
      !response.ok ||
      !result.success
    ) {
      throw new Error(
        result.message ||
        `Google Sheets returned HTTP ${response.status}`
      );
    }


    updateOrder(
      localOrderId,
      {
        sheetStatus:
          "SAVED",

        sheetSavedAt:
          new Date()
            .toISOString(),

        sheetError:
          null
      }
    );


    console.log(
      "Paid order saved to Google Sheets:",
      order.admissionCode
    );

  } catch (error) {
    updateOrder(
      localOrderId,
      {
        sheetStatus:
          "FAILED",

        sheetError:
          cleanText(
            error.message,
            500
          )
      }
    );


    console.error(
      "Google Sheets save failed:",
      error.message
    );
  }
}


/* ==========================================================================
   CONFIRMATION EMAIL
   ========================================================================== */

function buildConfirmationEmailText(
  order
) {
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
    "The purchaser named on the order must be present.",
    "Bring a driver's licence or another government-issued photo ID matching the purchaser.",
    "",
    "EVENT DETAILS",
    "Garba Night 2026",
    "Sunday, October 18, 2026",
    "7:00 PM – 11:00 PM",
    "Save Max Sports Centre",
    "1495 Sandalwood Pkwy E",
    "Brampton, ON L6R 0K2",
    "",
    `Order reference: ${order.localOrderId}`
  ].join("\n");
}


function buildConfirmationEmailHtml(
  order
) {
  const purchaser =
    escapeHtml(
      order.fullName
    );

  const code =
    escapeHtml(
      order.admissionCode
    );

  const reference =
    escapeHtml(
      order.localOrderId
    );


  return `
  <div style="
    background:#fff8f1;
    padding:32px 16px;
    color:#2b1712;
    font-family:Arial,Helvetica,sans-serif;
  ">

    <div style="
      max-width:620px;
      margin:auto;
      background:#fff;
      border:1px solid #efd6c8;
      border-radius:20px;
      overflow:hidden;
    ">

      <div style="
        padding:30px 24px;
        background:#bd351f;
        color:#fff;
        text-align:center;
      ">

        <div style="
          font-size:13px;
          font-weight:700;
          letter-spacing:2px;
          margin-bottom:8px;
        ">
          PAYMENT CONFIRMED
        </div>

        <h1 style="margin:0;">
          Garba Night 2026
        </h1>

      </div>


      <div style="padding:30px;">

        <p>
          Hello ${purchaser},
        </p>

        <p>
          Your payment has been confirmed.
          This email is your official
          Garba Night admission confirmation.
        </p>


        <div style="
          margin:24px 0;
          padding:24px;
          background:#fff3e6;
          border-radius:16px;
          text-align:center;
        ">

          <div style="
            font-size:13px;
            font-weight:700;
            letter-spacing:1.5px;
            color:#7b5549;
          ">
            ADMISSION CODE
          </div>

          <div style="
            margin-top:10px;
            font-size:31px;
            font-weight:800;
            color:#bd351f;
          ">
            ${code}
          </div>

        </div>


        <table style="
          width:100%;
          border-collapse:collapse;
        ">

          <tr>
            <td style="padding:10px 0;">
              Purchaser
            </td>

            <td style="
              padding:10px 0;
              text-align:right;
              font-weight:700;
            ">
              ${purchaser}
            </td>
          </tr>


          <tr>
            <td style="padding:10px 0;">
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
            <td style="padding:10px 0;">
              Amount paid
            </td>

            <td style="
              padding:10px 0;
              text-align:right;
              font-weight:700;
            ">
              ${formatCad(
                order.paidAmountCents
              )}
            </td>
          </tr>

        </table>


        <hr style="
          border:0;
          border-top:1px solid #efd6c8;
          margin:24px 0;
        ">


        <h3>
          Entry requirements
        </h3>

        <ul style="
          line-height:1.8;
        ">

          <li>
            Open this confirmation email
            at event check-in.
          </li>

          <li>
            The purchaser named on this
            order must be present.
          </li>

          <li>
            Bring a driver's licence or
            another government-issued photo ID
            matching the purchaser's name.
          </li>

        </ul>


        <div style="
          background:#faf7f5;
          padding:18px;
          border-radius:14px;
          line-height:1.65;
          margin-top:24px;
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
          margin-top:24px;
          font-size:12px;
          color:#8c7770;
        ">
          Order reference:
          ${reference}
        </p>

      </div>

    </div>

  </div>
  `;
}


function claimEmailDelivery(
  localOrderId
) {
  const orders =
    readOrders();

  const index =
    orders.findIndex(
      (order) =>
        order.localOrderId ===
        localOrderId
    );


  if (index === -1) {
    return null;
  }


  const order =
    orders[index];


  if (
    order.status !==
      "PAID" ||
    order.emailStatus ===
      "SENT" ||
    order.emailStatus ===
      "SENDING"
  ) {
    return null;
  }


  order.emailStatus =
    "SENDING";

  order.emailAttemptedAt =
    new Date()
      .toISOString();

  order.updatedAt =
    new Date()
      .toISOString();


  orders[index] =
    order;

  writeOrders(
    orders
  );

  return order;
}


async function sendConfirmationEmail(
  localOrderId
) {
  if (
    !emailTransporter
  ) {
    console.error(
      "Email not configured."
    );

    return;
  }


  const order =
    claimEmailDelivery(
      localOrderId
    );


  if (!order) {
    return;
  }


  try {
    const result =
      await emailTransporter
        .sendMail({
          from:
            EMAIL_FROM,

          to:
            order.email,

          subject:
            `Payment Confirmed — Garba Night 2026 — ${order.admissionCode}`,

          text:
            buildConfirmationEmailText(
              order
            ),

          html:
            buildConfirmationEmailHtml(
              order
            )
        });


    updateOrder(
      localOrderId,
      {
        emailStatus:
          "SENT",

        emailMessageId:
          result.messageId,

        emailSentAt:
          new Date()
            .toISOString(),

        emailError:
          null
      }
    );


    console.log(
      "Confirmation email sent:",
      order.email
    );

  } catch (error) {
    updateOrder(
      localOrderId,
      {
        emailStatus:
          "FAILED",

        emailError:
          cleanText(
            error.message,
            500
          )
      }
    );


    console.error(
      "Confirmation email failed:",
      error.message
    );
  }
}


/* ==========================================================================
   CORS
   ========================================================================== */

app.use(
  cors({
    origin: [
      FRONTEND_URL,
      "http://127.0.0.1:5500",
      "http://localhost:5500",
      "null"
    ]
  })
);


/* ==========================================================================
   SQUARE WEBHOOK
   IMPORTANT: MUST BE BEFORE express.json()
   ========================================================================== */

app.post(
  "/webhook",

  express.raw({
    type: "application/json"
  }),

  (
    request,
    response
  ) => {
    try {
      const rawBody =
        request.body.toString(
          "utf8"
        );


      const signature =
        request.get(
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
          .send(
            "Invalid signature"
          );
      }


      const event =
        JSON.parse(
          rawBody
        );


      console.log("");
      console.log(
        "Square webhook received"
      );

      console.log(
        "Event type:",
        event.type
      );


      if (
        event.type !==
        "payment.updated"
      ) {
        return response
          .status(200)
          .send(
            "Event ignored"
          );
      }


      const payment =
        event?.data
          ?.object
          ?.payment;


      if (!payment) {
        return response
          .status(200)
          .send(
            "No payment object"
          );
      }


      console.log(
        "Payment ID:",
        payment.id
      );

      console.log(
        "Payment status:",
        payment.status
      );


      /*
       * CRITICAL:
       *
       * NOTHING gets put in Google Sheets
       * here unless Square says COMPLETED.
       */
      if (
        payment.status !==
        "COMPLETED"
      ) {
        return response
          .status(200)
          .send(
            "Payment not completed"
          );
      }


      const squareOrderId =
        payment.order_id;


      const orders =
        readOrders();


      const orderIndex =
        orders.findIndex(
          (order) =>
            order.squareOrderId ===
            squareOrderId
        );


      if (
        orderIndex === -1
      ) {
        console.error(
          "Completed payment has no matching local order:",
          squareOrderId
        );

        return response
          .status(200)
          .send(
            "Unknown order"
          );
      }


      const order =
        orders[
          orderIndex
        ];


      /*
       * Duplicate webhook.
       *
       * Don't create another row.
       * Apps Script also independently
       * blocks duplicates.
       */
      if (
        order.status ===
        "PAID"
      ) {
        response
          .status(200)
          .send(
            "Already processed"
          );


        if (
          order.emailStatus !==
          "SENT"
        ) {
          setImmediate(
            () => {
              void sendConfirmationEmail(
                order.localOrderId
              );
            }
          );
        }


        if (
          order.sheetStatus !==
          "SAVED"
        ) {
          setImmediate(
            () => {
              void savePaidOrderToGoogleSheet(
                order.localOrderId
              );
            }
          );
        }


        return;
      }


      const paidAmountCents =
        Number(
          payment
            .amount_money
            ?.amount
        );


      const paidCurrency =
        payment
          .amount_money
          ?.currency;


      /*
       * Verify customer paid EXACTLY
       * what this order expected.
       */
      if (
        paidAmountCents !==
        Number(
          order.expectedAmountCents
        )
      ) {
        order.status =
          "MANUAL_REVIEW";

        order.reviewReason =
          "PAYMENT_AMOUNT_MISMATCH";

        order.paymentId =
          payment.id;

        order.webhookEventId =
          event.event_id;

        order.updatedAt =
          new Date()
            .toISOString();


        orders[
          orderIndex
        ] =
          order;


        writeOrders(
          orders
        );


        return response
          .status(200)
          .send(
            "Manual review required"
          );
      }


      if (
        paidCurrency !==
        "CAD"
      ) {
        order.status =
          "MANUAL_REVIEW";

        order.reviewReason =
          "PAYMENT_CURRENCY_MISMATCH";

        order.paymentId =
          payment.id;

        order.webhookEventId =
          event.event_id;

        order.updatedAt =
          new Date()
            .toISOString();


        orders[
          orderIndex
        ] =
          order;


        writeOrders(
          orders
        );


        return response
          .status(200)
          .send(
            "Manual review required"
          );
      }


      /*
       * PAYMENT IS NOW VERIFIED.
       *
       * Only NOW does the order become PAID.
       */
      order.status =
        "PAID";

      order.paymentStatus =
        "COMPLETED";

      order.paymentId =
        payment.id;

      order.paidAmountCents =
        paidAmountCents;

      order.currency =
        paidCurrency;

      order.admissionCode =
        order.admissionCode ||
        generateAdmissionCode();

      order.webhookEventId =
        event.event_id;

      order.paidAt =
        new Date()
          .toISOString();

      order.updatedAt =
        new Date()
          .toISOString();

      order.checkedIn =
        false;

      order.emailStatus =
        order.emailStatus ||
        "NOT_SENT";

      order.sheetStatus =
        order.sheetStatus ||
        "NOT_SAVED";


      orders[
        orderIndex
      ] =
        order;


      writeOrders(
        orders
      );


      console.log("");
      console.log(
        "GARBA ORDER VERIFIED"
      );

      console.log(
        "Purchaser:",
        order.fullName
      );

      console.log(
        "Tickets:",
        order.quantity
      );

      console.log(
        "Paid:",
        formatCad(
          paidAmountCents
        )
      );

      console.log(
        "Admission code:",
        order.admissionCode
      );


      /*
       * Respond to Square FIRST.
       */
      response
        .status(200)
        .send(
          "Payment verified"
        );


      /*
       * Only AFTER COMPLETED payment verification:
       *
       * 1. Send confirmation email.
       * 2. Add customer to Google Sheet.
       */
      setImmediate(
        () => {
          void sendConfirmationEmail(
            order.localOrderId
          );

          void savePaidOrderToGoogleSheet(
            order.localOrderId
          );
        }
      );

    } catch (error) {
      console.error(
        "Webhook processing failed:",
        error
      );

      response
        .sendStatus(
          400
        );
    }
  }
);


/* ==========================================================================
   NORMAL JSON
   ========================================================================== */

app.use(
  express.json()
);


/* ==========================================================================
   ENVIRONMENT VALIDATION
   ========================================================================== */

function validateEnvironment() {
  const required = {
    SQUARE_ACCESS_TOKEN,
    SQUARE_LOCATION_ID,
    SQUARE_WEBHOOK_SIGNATURE_KEY,
    SQUARE_WEBHOOK_URL,
    GMAIL_USER,
    GMAIL_APP_PASSWORD,
    GOOGLE_SHEETS_WEBHOOK_URL,
    GOOGLE_SHEETS_SECRET
  };


  const missing =
    Object
      .entries(
        required
      )
      .filter(
        (
          [, value]
        ) =>
          !value
      )
      .map(
        (
          [name]
        ) =>
          name
      );


  if (
    missing.length >
    0
  ) {
    throw new Error(
      `Missing environment variables: ${missing.join(
        ", "
      )}`
    );
  }
}


/* ==========================================================================
   HEALTH
   ========================================================================== */

app.get(
  "/health",
  (
    request,
    response
  ) => {
    response.json({
      success: true,

      message:
        "Garba payment server is running.",

      environment:
        SQUARE_ENVIRONMENT,

      ticketPriceCents:
        TICKET_PRICE_CENTS,

      maximumCapacity:
        MAX_CAPACITY,

      paidTickets:
        getPaidTicketCount(),

      pendingTickets:
        getPendingTicketCount(),

      remainingCapacity:
        getRemainingCapacity(),

      webhookConfigured:
        Boolean(
          SQUARE_WEBHOOK_SIGNATURE_KEY &&
          SQUARE_WEBHOOK_URL
        ),

      emailConfigured:
        Boolean(
          emailTransporter
        ),

      googleSheetsConfigured:
        Boolean(
          GOOGLE_SHEETS_WEBHOOK_URL &&
          GOOGLE_SHEETS_SECRET
        )
    });
  }
);


/* ==========================================================================
   CREATE CHECKOUT
   ========================================================================== */

app.post(
  "/api/create-checkout",

  async (
    request,
    response
  ) => {
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
              remainingCapacity ===
              0
                ? "Garba Night is currently sold out."
                : `Only ${remainingCapacity} ticket(s) are currently available.`
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
              customer.quantity ===
              1
                ? ""
                : "s"
            }`,

          price_money: {
            amount:
              totalAmountCents,

            currency:
              "CAD"
          },

          location_id:
            SQUARE_LOCATION_ID
        },


        checkout_options: {
          redirect_url:
            `${FRONTEND_URL}/index.html?payment=return`,

          ask_for_shipping_address:
            false,

          enable_coupon:
            false,

          enable_loyalty:
            false
        },


        pre_populated_data: {
          buyer_email:
            customer.email,

          buyer_phone_number:
            customer.phone
        },


        payment_note:
          localOrderId
      };


      const squareResponse =
        await fetch(
          `${SQUARE_API_BASE}/v2/online-checkout/payment-links`,

          {
            method:
              "POST",

            headers: {
              Authorization:
                `Bearer ${SQUARE_ACCESS_TOKEN}`,

              "Content-Type":
                "application/json",

              "Square-Version":
                "2026-07-15"
            },

            body:
              JSON.stringify(
                squareRequest
              )
          }
        );


      const squareData =
        await squareResponse
          .json();


      if (
        !squareResponse.ok
      ) {
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
              squareData
                .errors
                ?.[0]
                ?.detail ||
              squareData
                .errors
                ?.[0]
                ?.code ||
              "Square could not create the checkout."
          });
      }


      const paymentLink =
        squareData
          .payment_link;


      if (
        !paymentLink?.url ||
        !paymentLink?.order_id
      ) {
        return response
          .status(502)
          .json({
            success: false,

            message:
              "Square did not return a valid checkout link."
          });
      }


      const now =
        new Date()
          .toISOString();


      /*
       * Consent is captured when the user
       * actively checks the optional box.
       */
      const marketingConsentTimestamp =
        customer
          .marketingConsent
          ? now
          : null;


      const orders =
        readOrders();


      /*
       * This order IS stored locally as PENDING
       * because we need to match Square's eventual
       * webhook to the customer.
       *
       * BUT IT IS NOT SENT TO GOOGLE SHEETS YET.
       */
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

        quantity:
          customer.quantity,

        ticketPriceCents:
          TICKET_PRICE_CENTS,

        expectedAmountCents:
          totalAmountCents,

        currency:
          "CAD",

        marketingConsent:
          customer.marketingConsent,

        marketingConsentTimestamp,

        marketingConsentSource:
          customer
            .marketingConsent
            ? "Garba Night 2026 online checkout"
            : null,

        marketingConsentVersion:
          customer
            .marketingConsent
            ? "1"
            : null,

        status:
          "PENDING",

        paymentStatus:
          "PENDING",

        paymentId:
          null,

        admissionCode:
          null,

        emailStatus:
          "NOT_SENT",

        emailMessageId:
          null,

        emailAttemptedAt:
          null,

        emailSentAt:
          null,

        emailError:
          null,

        sheetStatus:
          "NOT_SAVED",

        sheetAttemptedAt:
          null,

        sheetSavedAt:
          null,

        sheetError:
          null,

        checkedIn:
          false,

        reviewReason:
          null,

        createdAt:
          now,

        updatedAt:
          now,

        paidAt:
          null,

        expiredAt:
          null
      });


      writeOrders(
        orders
      );


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
        "Marketing consent:",
        customer
          .marketingConsent
      );

      console.log(
        "NOT added to Google Sheets — payment pending."
      );


      response.json({
        success:
          true,

        checkoutUrl:
          paymentLink.url,

        squareOrderId:
          paymentLink.order_id,

        localOrderId,

        quantity:
          customer.quantity,

        totalAmountCents,

        remainingCapacity:
          getRemainingCapacity()
      });

    } catch (error) {
      console.error(
        "Checkout creation failed:",
        error
      );


      response
        .status(400)
        .json({
          success:
            false,

          message:
            error.message ||
            "Unable to create checkout."
        });
    }
  }
);


/* ==========================================================================
   SAFE ORDER STATUS
   ========================================================================== */

app.get(
  "/api/order/:localOrderId",

  (
    request,
    response
  ) => {
    const localOrderId =
      cleanText(
        request.params
          .localOrderId,
        100
      );


    const order =
      readOrders()
        .find(
          (item) =>
            item.localOrderId ===
            localOrderId
        );


    if (!order) {
      return response
        .status(404)
        .json({
          success:
            false,

          message:
            "Order not found."
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
          order.status ===
          "PAID"
            ? order.admissionCode
            : null,

        emailStatus:
          order.emailStatus,

        sheetStatus:
          order.sheetStatus
      }
    });
  }
);


/* ==========================================================================
   START
   ========================================================================== */

try {
  ensureOrdersFile();

  validateEnvironment();


  app.listen(
    PORT,
    () => {
      console.log("");
      console.log(
        "Garba payment backend started"
      );

      console.log(
        `Server: http://localhost:${PORT}`
      );

      console.log(
        `Square environment: ${SQUARE_ENVIRONMENT}`
      );

      console.log(
        `Ticket price: ${formatCad(
          TICKET_PRICE_CENTS
        )}`
      );

      console.log(
        `Maximum capacity: ${MAX_CAPACITY}`
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

      console.log(
        "Google Sheets: configured"
      );

      console.log("");
    }
  );

} catch (error) {
  console.error(
    "Server could not start:",
    error.message
  );

  process.exit(1);
}