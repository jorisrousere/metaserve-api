# MetaServe API - Skeleton (sans api/index.ts)

Ce dossier contient tous les fichiers necessaires **sauf** `api/index.ts`.
Copier le `index.ts` fourni et le placer dans `api/index.ts`.

## Fichiers inclus
- `.gitignore` — ignore les fichiers sensibles et de build
- `package.json` — dependances et scripts (`postinstall` Prisma et `dev` local via tsx)
- `tsconfig.json` — configuration TypeScript compatible Vercel
- `vercel.json` — runtime Node et region FRA1
- `prisma/schema.prisma` — datasource + generator (ajouter vos modeles)
- `.env.example` — gabarit d env (remplir puis creer les vars sur Vercel)

## Utilisation

1) Placer votre `api/index.ts` dans `api/`.
2) Installer les dependances:
   ```bash
   pnpm i  # ou npm i
   ```
3) Generer Prisma:
   ```bash
   npx prisma generate
   ```
4) Migrations (depuis votre machine, cible Neon):
   ```bash
   npx prisma migrate deploy
   ```
5) Deploiement Vercel:
   - Importer le repo sur Vercel
   - Ajouter `DATABASE_URL` et `DIRECT_URL` dans Settings -> Environment Variables
   - Deployer
6) Test:
   - GET `/api/health` doit repondre `{ ok: true }`

## Notes
- Garder les secrets hors du client. Ne jamais exposer `DATABASE_URL` dans un `VITE_*`.
- Les routes `player-stats` masquent `durability` et `potential` dans votre `index.ts`.
