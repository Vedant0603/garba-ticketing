"use strict";

const API_BASE =
  "http://localhost:3000";

const TICKET_PRICE_CENTS =
  1000;

document.addEventListener(
  "DOMContentLoaded",
  () => {
    const form =
      document.querySelector(
        "#ticket-form"
      );

    if (!form) {
      console.error(
        'Could not find #ticket-form'
      );

      return;
    }

    const quantityInput =
      document.querySelector(
        "#quantity"
      );

    const fullNameInput =
      document.querySelector(
        "#fullName"
      );

    const emailInput =
      document.querySelector(
        "#email"
      );

    const phoneInput =
      document.querySelector(
        "#phone"
      );

    const notesInput =
      document.querySelector(
        "#notes"
      );

    const agreementInput =
      document.querySelector(
        "#agreement"
      );

    const payButton =
      document.querySelector(
        "#pay-button"
      );

    /*
     * Handle customer returning from Square.
     *
     * We deliberately DO NOT show backend/payment
     * verification details to the customer.
     */
    const url =
      new URL(
        window.location.href
      );

    if (
      url.searchParams.get(
        "payment"
      ) === "return"
    ) {
      alert(
        "Thank you! Your order has been submitted successfully.\n\nYour Garba Night confirmation and admission code will be sent to your email and phone number.\n\nAt the event, show either the live email or live text message and bring your driver's licence or another government-issued photo ID."
      );

      /*
       * Remove ?payment=return so refreshing
       * does not show the message again.
       */
      window.history.replaceState(
        {},
        document.title,
        `${window.location.pathname}#tickets`
      );
    }

    /* ---------------------------------------------------------------------- */
    /* Order summary                                                          */
    /* ---------------------------------------------------------------------- */

    function getQuantity() {
      const value =
        Number(
          quantityInput?.value ||
            1
        );

      if (
        !Number.isInteger(
          value
        ) ||
        value < 1
      ) {
        return 1;
      }

      return value;
    }

    function formatMoney(
      cents
    ) {
      return new Intl.NumberFormat(
        "en-CA",
        {
          style:
            "currency",

          currency:
            "CAD",
        }
      ).format(
        cents / 100
      );
    }

    function updateSummary() {
      const quantity =
        getQuantity();

      const total =
        quantity *
        TICKET_PRICE_CENTS;

      /*
       * These selectors support several common
       * IDs/classes so your existing HTML does
       * not need unnecessary changes.
       */

      const quantityDisplays =
        document.querySelectorAll(
          "[data-ticket-quantity], #summary-quantity"
        );

      quantityDisplays.forEach(
        (element) => {
          element.textContent =
            quantity;
        }
      );

      const subtotalDisplays =
        document.querySelectorAll(
          "[data-ticket-subtotal], #summary-subtotal"
        );

      subtotalDisplays.forEach(
        (element) => {
          element.textContent =
            formatMoney(
              total
            );
        }
      );

      const totalDisplays =
        document.querySelectorAll(
          "[data-ticket-total], #summary-total"
        );

      totalDisplays.forEach(
        (element) => {
          element.textContent =
            formatMoney(
              total
            );
        }
      );
    }

    if (quantityInput) {
      quantityInput.addEventListener(
        "input",
        updateSummary
      );

      quantityInput.addEventListener(
        "change",
        updateSummary
      );
    }

    updateSummary();

    /* ---------------------------------------------------------------------- */
    /* Checkout                                                               */
    /* ---------------------------------------------------------------------- */

    form.addEventListener(
      "submit",

      async (event) => {
        /*
         * CRITICAL:
         *
         * Prevent normal HTML form submission.
         * Otherwise the page refreshes and clears
         * everything instead of going to Square.
         */
        event.preventDefault();

        const quantity =
          getQuantity();

        const fullName =
          fullNameInput?.value
            ?.trim();

        const email =
          emailInput?.value
            ?.trim();

        const phone =
          phoneInput?.value
            ?.trim();

        const notes =
          notesInput?.value
            ?.trim() ||
          "";

        if (
          !fullName ||
          fullName.length < 2
        ) {
          alert(
            "Please enter the purchaser's full legal name."
          );

          fullNameInput?.focus();

          return;
        }

        if (!email) {
          alert(
            "Please enter your email address."
          );

          emailInput?.focus();

          return;
        }

        if (!phone) {
          alert(
            "Please enter your phone number."
          );

          phoneInput?.focus();

          return;
        }

        if (
          agreementInput &&
          !agreementInput.checked
        ) {
          alert(
            "Please confirm the entry requirements before continuing."
          );

          agreementInput.focus();

          return;
        }

        const originalButtonText =
          payButton?.textContent ||
          "Pay Securely with Square";

        if (payButton) {
          payButton.disabled =
            true;

          payButton.textContent =
            "Opening Secure Checkout...";
        }

        try {
          const response =
            await fetch(
              `${API_BASE}/api/create-checkout`,

              {
                method:
                  "POST",

                headers: {
                  "Content-Type":
                    "application/json",
                },

                body:
                  JSON.stringify({
                    fullName,
                    email,
                    phone,
                    notes,
                    quantity,
                  }),
              }
            );

          const data =
            await response.json();

          if (
            !response.ok ||
            !data.success
          ) {
            throw new Error(
              data.message ||
                "Unable to create checkout."
            );
          }

          if (
            !data.checkoutUrl
          ) {
            throw new Error(
              "Square checkout URL was not returned."
            );
          }

          /*
           * Store this only for the current browser
           * in case we need it later.
           */
          if (
            data.localOrderId
          ) {
            sessionStorage.setItem(
              "garbaLocalOrderId",
              data.localOrderId
            );
          }

          /*
           * THIS sends the customer to Square.
           */
          window.location.assign(
            data.checkoutUrl
          );
        } catch (error) {
          console.error(
            "Checkout error:",
            error
          );

          alert(
            error.message ||
              "Unable to open Square checkout. Please try again."
          );

          if (payButton) {
            payButton.disabled =
              false;

            payButton.textContent =
              originalButtonText;
          }
        }
      }
    );
  }
);