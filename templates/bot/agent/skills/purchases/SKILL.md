---
name: purchases
description: Load before you buy, book, order, reserve, subscribe to, or pay for anything for the user, before shopping or booking starts and not only at checkout, and whenever the user offers, sends, or mentions a payment card.
---

# Purchases and payments

You can shop, book and check out for the user on your own computer's browser. You never spend on your own: every purchase needs the user's explicit yes for that exact order.

## Before checkout

1. Pin down what the user wants: the item or service, quantity, size or variant, dates, delivery address, and any budget. Use what the user told you and memory; ask only for what is really missing.
2. Find it and compare when that helps. Share options as Markdown links with prices, using the exact URLs you found.
3. Sign in or create accounts following the `sign-in` skill.

## Confirm the total

1. Go through checkout up to, but not including, the final pay/submit button.
2. Read the real numbers from the page: item, merchant, quantity, shipping, taxes, fees, total and currency, delivery or booking dates, and the cancellation or refund terms when shown.
3. Ask for an explicit yes with `ask_user`: a short question stating merchant, item and the exact total, with a primary option to place the order and a second option to cancel. Never assume a yes from an earlier message, from "just order it" before you knew the total, or from a routine.
4. If anything changes after the yes (price, total, dates, item), stop and ask again.

## Card details

- Enter a card only through `request_form` at the live checkout page: one field per input the page shows (card number, expiry, security code, name on card, billing postcode), naming the site. The hub fills the page directly; you never see the values. If the form can't fill a field (some embedded card frames), use `request_login` so the user types it on the screen.
- A bank verification step (a code by SMS, an app approval, a 3-D Secure page) goes to `request_form` for a code or `request_login` for anything else.
- If the user sends card details in chat anyway, use them for this checkout only. Never repeat them, never save them to memory, files, skills or routine prompts, and never type them anywhere except the merchant's payment fields.
- Don't lecture the user about how to pay.

## Place the order

1. Click the final pay/submit button only after the user's explicit yes.
2. Wait for the confirmation page.
3. Save proof: a PDF or screenshot of the confirmation page in /data/out, and send it with `send_file`. Tell the user the order or booking number, the total charged, and what happens next (delivery date, check-in time).
4. If a confirmation email arrives in a connected inbox, mention it.

## When something fails

- After an error, timeout, or a page that hangs after you clicked pay, **don't click pay again**. First check whether the order went through: the confirmation page, the account's order history, or a confirmation email. Retry only once you know it didn't, and with the user's yes.
- A declined card or a failed verification goes back to the user; don't try another card on your own.
- A purchase the user declined is final; don't ask again for the same order.
