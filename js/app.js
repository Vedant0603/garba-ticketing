"use strict";


/* ==========================================================================
   PRODUCTION CONFIGURATION
   ========================================================================== */

const API_BASE =
  "https://garba-ticketing-production.up.railway.app";

const TICKET_PRICE_CENTS =
  1100;

const MAX_CAPACITY =
  1000;


/* ==========================================================================
   START
   ========================================================================== */

document.addEventListener(
  "DOMContentLoaded",
  () => {

    const form =
      document.querySelector(
        "#ticket-form"
      );


    if (!form) {
      console.error(
        "Could not find #ticket-form"
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

    const marketingConsentInput =
      document.querySelector(
        "#marketingConsent"
      );

    const agreementInput =
      document.querySelector(
        "#agreement"
      );

    const payButton =
      document.querySelector(
        "#pay-button"
      );

    const summaryBuyButton =
      document.querySelector(
        "#summary-buy-button"
      );


    /* ======================================================================
       SQUARE RETURN
       ====================================================================== */

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
        "Thank you! Your order has been submitted successfully.\n\n" +
        "Once Square confirms your payment, your Garba Night confirmation and admission code will be sent to your email.\n\n" +
        "At the event, show the confirmation email and bring government-issued photo ID matching the purchaser's name."
      );


      window.history.replaceState(
        {},
        document.title,
        `${window.location.pathname}#tickets`
      );
    }


    /* ======================================================================
       QUANTITY
       ====================================================================== */

    function getQuantity() {

      let quantity =
        Number(
          quantityInput?.value ||
          1
        );


      if (
        !Number.isInteger(
          quantity
        ) ||
        quantity < 1
      ) {
        quantity = 1;
      }


      if (
        quantity >
        MAX_CAPACITY
      ) {
        quantity =
          MAX_CAPACITY;
      }


      return quantity;
    }


    /* ======================================================================
       MONEY
       ====================================================================== */

    function formatMoney(
      cents
    ) {
      return new Intl.NumberFormat(
        "en-CA",
        {
          style:
            "currency",

          currency:
            "CAD"
        }
      ).format(
        cents / 100
      );
    }


    /* ======================================================================
       SUMMARY
       ====================================================================== */

    function updateSummary() {

      const quantity =
        getQuantity();


      const total =
        quantity *
        TICKET_PRICE_CENTS;


      const quantityDisplays =
        document.querySelectorAll(
          "[data-ticket-quantity], #summary-quantity"
        );


      quantityDisplays.forEach(
        (element) => {

          element.textContent =
            String(
              quantity
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


    if (
      quantityInput
    ) {

      quantityInput.setAttribute(
        "min",
        "1"
      );

      quantityInput.setAttribute(
        "max",
        String(
          MAX_CAPACITY
        )
      );


      quantityInput.addEventListener(
        "input",
        updateSummary
      );


      quantityInput.addEventListener(
        "change",
        () => {

          quantityInput.value =
            String(
              getQuantity()
            );


          updateSummary();
        }
      );
    }


    updateSummary();


    /* ======================================================================
       SUMMARY BUY BUTTON
       ====================================================================== */

    if (
      summaryBuyButton &&
      payButton
    ) {

      summaryBuyButton.addEventListener(
        "click",
        () => {

          payButton.scrollIntoView({
            behavior:
              "smooth",

            block:
              "center"
          });

        }
      );
    }


    /* ======================================================================
       CHECKOUT
       ====================================================================== */

    form.addEventListener(
      "submit",

      async (
        event
      ) => {

        event.preventDefault();


        const quantity =
          getQuantity();


        const fullName =
          fullNameInput?.value
            ?.trim() ||
          "";


        const email =
          emailInput?.value
            ?.trim() ||
          "";


        const phone =
          phoneInput?.value
            ?.trim() ||
          "";


        const marketingConsent =
          Boolean(
            marketingConsentInput
              ?.checked
          );


        /* ------------------------------------------------------------------
           VALIDATION
           ------------------------------------------------------------------ */

        if (
          quantity < 1 ||
          quantity >
          MAX_CAPACITY
        ) {

          alert(
            "Please select a valid number of tickets."
          );

          quantityInput?.focus();

          return;
        }


        if (
          fullName.length <
          2
        ) {

          alert(
            "Please enter the purchaser's full legal name."
          );

          fullNameInput?.focus();

          return;
        }


        const emailPattern =
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/;


        if (
          !emailPattern.test(
            email
          )
        ) {

          alert(
            "Please enter a valid email address."
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
          payButton?.textContent
            ?.trim() ||
          "Buy Tickets";


        if (
          payButton
        ) {

          payButton.disabled =
            true;

          payButton.textContent =
            "Opening Secure Checkout...";
        }


        if (
          summaryBuyButton
        ) {

          summaryBuyButton.disabled =
            true;
        }


        /* ------------------------------------------------------------------
           CALL RAILWAY
           ------------------------------------------------------------------ */

        try {

          const response =
            await fetch(
              `${API_BASE}/api/create-checkout`,

              {
                method:
                  "POST",

                headers: {

                  "Content-Type":
                    "application/json"

                },

                body:
                  JSON.stringify({

                    fullName,

                    email,

                    phone,

                    quantity,

                    marketingConsent

                  })
              }
            );


          let data;


          try {

            data =
              await response.json();

          } catch {

            throw new Error(
              "The ticket server returned an invalid response."
            );

          }


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


          if (
            data.localOrderId
          ) {

            sessionStorage.setItem(
              "garbaLocalOrderId",
              data.localOrderId
            );

          }


          window.location.assign(
            data.checkoutUrl
          );


        } catch (
          error
        ) {

          console.error(
            "Checkout error:",
            error
          );


          alert(
            error?.message ||
            "Unable to open Square checkout. Please try again."
          );


          if (
            payButton
          ) {

            payButton.disabled =
              false;

            payButton.textContent =
              originalButtonText;

          }


          if (
            summaryBuyButton
          ) {

            summaryBuyButton.disabled =
              false;

          }

        }

      }
    );

  }
);