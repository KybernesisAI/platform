# eyes-spike

The verification fixture for the engineer-workshop vision loop (2026-08-06):
sandbox (Docker) + Playwright template bootstrap + screenshot_html tool returning
pixels via toModelOutput content parts, with a random code stamped into the image
(hidden from the model's tool-result view) as the vision proof.

Verified: cold-start bootstrap works; warm sessions complete the full
render→screenshot→vision→report loop in ~6s; model read the hidden stamp
correctly in 3/3 runs. Seed code for @kybernesis/engineer.
