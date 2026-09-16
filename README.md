# Assets Scraper

Paste a URL, get every SVG, image and font on the page, plus the brand color palette. Select what you need and download it as a ZIP.

## Development

Requirements: Node 22+, pnpm 10.33, Google Chrome.

```bash
pnpm install
pnpm dev            # http://localhost:3000
pnpm test           # unit and DOM tests
pnpm test:integration
pnpm test:e2e
```

Set CHROME_EXECUTABLE_PATH if Chrome is not in the default location.
