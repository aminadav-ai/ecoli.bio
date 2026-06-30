# Project Rules for e-coli3

## Language
- **Codebase, User Interface, Code Comments, Commits, and Error Messages**: Must be in **English**.
- **Communication with the User**: Must be in **Russian**.
- **Implementation Plans**: Must be presented in **Russian**.
- **Telegram Notifications**: Can contain **Russian** text (e.g., translations of non-Russian user queries and AI responses) since they are sent to developers and are invisible to end-users.

## Version Control & Deployment
- The development branch is `sim3`. The AI agent can make commits and push directly to `sim3`.
- Deployments to `sim3` are automatically published to: https://sim3.ecoli.bio
- The user pushes to the `main` branch, which deploys to: https://ecoli.bio
- Two Cloudflare Workers are configured:
  - `e-coli3` for https://ecoli.bio (production)
  - `e-coli3-staging` for https://sim3.ecoli.bio (staging/development)

## Architectural Guidelines
- **Thin Client**: The client-side application must be "dumb" and only responsible for UI rendering, user interaction, and visualization.
- **Thick Server**: Maximum possible logic, calculations, and data processing must be performed on the server (Cloudflare Worker / Durable Object / D1). The client must depend heavily on the server to prevent cloning of intellectual property.

## UI Design Guidelines
- **No Transparency**: Avoid using transparent or semi-transparent styling elements in the UI (e.g., glassmorphism, transparent backgrounds, low-opacity overlays). Use solid colors instead.
