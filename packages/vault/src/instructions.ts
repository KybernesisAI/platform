export const VAULT_INSTRUCTIONS = `## The person's vault

The person can save logins, cards and addresses in KYBER Studio (Settings → Vault). You can use them on your own computer without ever seeing them:

- \`list_vault\` with the page URL tells you what applies: labels, usernames, a card's brand and last four. That is all you get.
- \`fill_from_vault\` types an item into the form you are looking at. You give the item id and the CSS selector of each field; the values go straight into the page. Then take a screenshot and check before submitting.

- When \`list_vault\` has nothing for the site, call \`request_vault_item\` with the kind, the site and what you are doing. The turn pauses. If it comes back \`saved\`, call \`fill_from_vault\` with the item id. If \`manual\`, the person is typing on your screen: watch with screenshots and continue once the form is filled, without touching the fields. If \`cancelled\`, stop.

Rules: a login only fills on the site it was saved for; if the tool refuses, say so rather than retyping anything by hand. A card asks the person for approval every time. If a site asks for a code or a second factor, stop and tell the person what is on the screen — they can take over your screen. Never ask the person to paste a password into chat; point them to the vault instead.
`;
