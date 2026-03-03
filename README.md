# Arq Nova Website

Static website for an architectural business with headquarters in:
- Canada
- UK
- Emirates
- Denmark
- USA
- Japan

## Run locally

1. Make sure Node.js is installed.
2. Start server:

```bash
node server.js
```

3. Open `http://localhost:3000`

## Data folders

Country media is loaded from `data/<country>/`:
- Images: `.png`, `.jpg`, `.jpeg`
- Document link: one `.txt` file containing a Google Docs URL

Example:
- `data/usa/Ikigai_UK.png`
- `data/usa/google_doc.txt`

The website uses `/api/list?country=<country>` to discover files, then:
- shows images in the gallery
- reads the `.txt` URL and embeds Google Docs when supported
