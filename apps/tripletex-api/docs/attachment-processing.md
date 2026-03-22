# Attachment Processing

Attachment handling is implemented as a fail-soft pipeline.

## Processing Order

1. direct text extraction for text-like files
2. Google Document AI for PDFs and images when configured
3. AI fallback for attachment understanding when OCR is unavailable or insufficient
4. metadata-only fallback when no text can be recovered safely

Implementation:

- `api/_lib/attachments.ts`
- `api/solve.ts`

## Operational Notes

- Production has been verified to use Google Document AI successfully.
- Attachment results are summarized into line-oriented facts so downstream extraction can reason over OCR output without depending on raw layout.
- The main failure mode has historically been semantic interpretation after OCR, not complete OCR failure.

## Environment Variables

- `DOC_AI_PROJECT_ID`
- `DOC_AI_LOCATION`
- `DOC_AI_PROCESSOR_ID`
- `DOC_AI_PROCESSOR_VERSION` (optional)
- `DOC_AI_TIMEOUT_MS` (optional)
- `DOC_AI_CREDENTIALS_JSON`

## Debugging

For controlled probes, use `?debug=1` and inspect:

- `x-tripletex-attachment-providers`
- `x-tripletex-prompt-fingerprint`
- `_debug.attachmentProviders` in the response body
