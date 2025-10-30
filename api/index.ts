// Commentaire: API Express pour exposer les stats et les tournois depuis la base
// Commentaire: les commentaires sont en troisieme personne et sans accents

import express from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/client";

// Commentaire: imports pour les routes tournois
import { z } from "zod";
import { GraphQLClient, gql } from "graphql-request";
import {
  createPublicClient,
  http,
  parseAbi,
  hashMessage,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";

const prisma = new PrismaClient();
const app = express();

app.use(cors());
app.use(express.json());

// -----------------------------------------------------------------------------
// Commentaire: Helpers generiques pour la partie tournois
// -----------------------------------------------------------------------------

// Commentaire: endpoint subgraph optionnel pour verif d ownership
const GOLDSKY_ENDPOINT = process.env.GOLDSKY_ENDPOINT || "";

// Commentaire: normalise une adresse hexa en minuscule
function toLowerHex(s: string) {
  return (s || "").toLowerCase();
}

// Commentaire: construit le message a signer pour une inscription
function buildRegistrationMessage(
  tournamentId: string,
  contractAddress: string,
  tokenId: string,
  timestamp: number
) {
  return `MetaServe Tournament Registration\nTournament: ${tournamentId}\nCard: ${toLowerHex(
    contractAddress
  )}#${tokenId}\nTimestamp: ${timestamp}`;
}

// Commentaire: lit l owner courant d un NFT via le subgraph (optionnel)
async function fetchCurrentOwner(contractAddress: string, tokenId: string) {
  if (!GOLDSKY_ENDPOINT) return null;
  const client = new GraphQLClient(GOLDSKY_ENDPOINT);
  const query = gql`
    query CurrentOwner($id: ID!) {
      token(id: $id) {
        id
        owner {
          id
        }
      }
    }
  `;
  const id = `${toLowerHex(contractAddress)}-${String(tokenId)}`;
  try {
    const data = await client.request<{ token?: { owner?: { id?: string } } }>(
      query,
      { id }
    );
    const owner = data?.token?.owner?.id || null;
    return owner ? toLowerHex(owner) : null;
  } catch (e: any) {
    console.error("Goldsky error:", e?.message || String(e));
    return null;
  }
}

// -----------------------------------------------------------------------------
// Commentaire: verif universelle EOA + EIP-1271 + ERC-6492 via viem Actions
// -----------------------------------------------------------------------------

const EIP1271_ABI = parseAbi([
  "function isValidSignature(bytes32 _hash, bytes _signature) view returns (bytes4)",
]);
const EIP1271_MAGIC = "0x1626ba7e";

function pickChain(chainId?: number) {
  // Commentaire: 84532 = Base Sepolia
  if (chainId === 84532) return baseSepolia;
  return base;
}

// Commentaire: helper 6492 simple pour log
function looksLikeErc6492(sig: string): boolean {
  if (typeof sig !== "string" || !sig.startsWith("0x")) return false;
  const hex = sig.slice(2).toLowerCase();
  if (hex.length < 8) return false;
  return hex.endsWith("64926492") || hex.endsWith("064926492");
}

async function verifyAnySignature(opts: {
  address: Address;
  message: string;
  signature: Hex;
  chainId?: number;
  rpcUrl?: string;
}): Promise<boolean> {
  const client = createPublicClient({
    chain: pickChain(opts.chainId),
    transport: http(opts.rpcUrl || process.env.RPC_URL || ""),
  });

  // Commentaire: normalise les sauts de ligne
  const msg = opts.message.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Commentaire: voie principale - Actions viem (gere EOA + 1271 + 6492)
  try {
    const ok = await client.verifyMessage({
      address: opts.address,
      message: msg,
      signature: opts.signature,
    });
    if (ok) return true;
  } catch (e) {
    if (looksLikeErc6492(opts.signature)) {
      console.warn("[verifyAnySignature] Signature 6492 detectee; verifier version de viem et du RPC");
    }
    // continue vers fallback
  }

  // Commentaire: fallback EOA si l adresse n est pas un contrat
  try {
    const code = await client.getBytecode({ address: opts.address });
    const isContract = !!code && code !== "0x";
    if (!isContract) {
      // Commentaire: re-tente verifyMessage (erreurs transitoires possibles)
      const ok2 = await client.verifyMessage({
        address: opts.address,
        message: msg,
        signature: opts.signature,
      });
      if (ok2) return true;
    }
  } catch {
    // ignore
  }

  // Commentaire: fallback EIP-1271 manuel si smart wallet deploye
  try {
    const code = await client.getBytecode({ address: opts.address });
    const isContract = !!code && code !== "0x";
    if (isContract) {
      const h = hashMessage(msg); // Commentaire: hash EIP-191
      const res = await client.readContract({
        address: opts.address,
        abi: EIP1271_ABI,
        functionName: "isValidSignature",
        args: [h, opts.signature],
      });
      if (String(res).toLowerCase() === EIP1271_MAGIC) return true;
    }
  } catch {
    // ignore
  }

  return false;
}

// -----------------------------------------------------------------------------
// Commentaire: helper pour masquer certaines stats joueurs
// -----------------------------------------------------------------------------
function stripHiddenStats<T extends { durability?: unknown; potential?: unknown }>(row: T) {
  // Commentaire: retire durability et potential des objets
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { durability, potential, ...safe } = row as any;
  return safe as Omit<T, "durability" | "potential">;
}

// -----------------------------------------------------------------------------
// Commentaire: endpoint de sante
// -----------------------------------------------------------------------------
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// -----------------------------------------------------------------------------
// Commentaire: STATS JOUEURS (existant)
// -----------------------------------------------------------------------------

// Commentaire: recupere une liste de stats par liste d ids
// Commentaire: GET /api/player-stats?ids=1,2,3
app.get("/api/player-stats", async (req, res) => {
  try {
    const idsParam = (req.query.ids as string | undefined) ?? "";
    const ids = idsParam
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n));
    if (ids.length === 0) {
      return res.json([]);
    }
    const rows = await prisma.playerStat.findMany({
      where: { tokenId: { in: ids } },
      orderBy: { tokenId: "asc" },
    });
    // Commentaire: masque durability et potential avant reponse
    res.json(rows.map(stripHiddenStats));
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// Commentaire: recupere une fiche unique
// Commentaire: GET /api/player-stats/1
app.get("/api/player-stats/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "invalid id" });
    }
    const row = await prisma.playerStat.findUnique({ where: { tokenId: id } });
    if (!row) return res.status(404).json({ error: "not found" });
    // Commentaire: masque durability et potential avant reponse
    res.json(stripHiddenStats(row));
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// -----------------------------------------------------------------------------
// Commentaire: TOURNOIS (nouveau) - suit le meme pattern que player-stats
// -----------------------------------------------------------------------------

// Commentaire: liste des tournois
app.get("/api/tournaments", async (_req, res) => {
  try {
    const list = await prisma.tournament.findMany({
      orderBy: { startsAt: "asc" },
      select: {
        id: true,
        slug: true,
        title: true,
        description: true,
        status: true,
        capacity: true,
        startsAt: true,
        maxEntriesPerWallet: true,
      },
    });
    res.json(list);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// Commentaire: detail d un tournoi (entries + matches)
app.get("/api/tournaments/:id", async (req, res) => {
  try {
    const t = await prisma.tournament.findUnique({
      where: { id: req.params.id },
      include: { entries: { include: { wallet: true } }, matches: true },
    });
    if (!t) return res.status(404).json({ error: "not found" });
    res.json(t);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
});

// Commentaire: creation d un tournoi (admin)
app.post("/api/tournaments", async (req, res) => {
  const schema = z.object({
    slug: z.string().min(3),
    title: z.string().min(3),
    description: z.string().optional(),
    capacity: z.number().int().positive(),
    startsAt: z.string(),
    maxEntriesPerWallet: z.number().int().positive().default(3),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.message });

  try {
    const { slug, title, description, capacity, startsAt, maxEntriesPerWallet } =
      parsed.data;
    const t = await prisma.tournament.create({
      data: {
        slug,
        title,
        description: description || null,
        capacity,
        startsAt: new Date(startsAt),
        status: "OPEN",
        maxEntriesPerWallet,
      },
    });
    res.json(t);
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});

// Commentaire: inscription a un tournoi (signature requise)
app.post("/api/tournaments/:id/register", async (req, res) => {
  const schema = z.object({
    walletAddress: z.string().min(5),
    contractAddress: z.string().min(5),
    tokenId: z.string().min(1),
    signature: z.string().min(10),
    timestamp: z.number().int().positive(),
    // Ajouts optionnels pour support AA
    signedMessage: z.string().min(1).optional(),
    chainId: z.number().int().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.message });

  try {
    const t = await prisma.tournament.findUnique({
      where: { id: req.params.id },
    });
    if (!t) return res.status(404).json({ error: "tournament not found" });
    if (t.status !== "OPEN")
      return res.status(400).json({ error: "registrations closed" });

    const walletAddress = toLowerHex(parsed.data.walletAddress);
    const contractAddress = toLowerHex(parsed.data.contractAddress);
    const tokenId = String(parsed.data.tokenId);
    const { signature, timestamp } = parsed.data;

    // Commentaire: verifie la signature du message
    // Utilise la chaine envoyee par le front si presente, sinon reconstruit le message canonical
    const message =
      parsed.data.signedMessage && parsed.data.signedMessage.length > 0
        ? parsed.data.signedMessage
        : buildRegistrationMessage(t.id, contractAddress, tokenId, timestamp);

    const ok = await verifyAnySignature({
      address: walletAddress as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
      chainId: parsed.data.chainId,
    });
    if (!ok)
      return res.status(400).json({ error: "signature verification failed" });

    // Commentaire: verif ownership optionnelle via subgraph
    if (GOLDSKY_ENDPOINT) {
      const current = await fetchCurrentOwner(contractAddress, tokenId);
      if (!current || current !== walletAddress) {
        return res.status(400).json({ error: "ownership check failed" });
      }
    }

    // Commentaire: limite par wallet
    const wallet = await prisma.wallet.upsert({
      where: { address: walletAddress },
      update: {},
      create: { address: walletAddress },
    });
    const count = await prisma.entry.count({
      where: { tournamentId: t.id, walletId: wallet.id },
    });
    if (count >= t.maxEntriesPerWallet) {
      return res.status(400).json({ error: "wallet reached max entries" });
    }

    // Commentaire: cree l entree (un NFT par tournoi)
    const entry = await prisma.entry.create({
      data: {
        tournamentId: t.id,
        walletId: wallet.id,
        contractAddress,
        tokenId,
        uniqueEntry: `${t.id}:${wallet.id}:${contractAddress}:${tokenId}`,
      },
    });
    res.json(entry);
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});

// Commentaire: cloture des inscriptions
app.post("/api/tournaments/:id/lock", async (req, res) => {
  try {
    const t = await prisma.tournament.findUnique({
      where: { id: req.params.id },
    });
    if (!t) return res.status(404).json({ error: "tournament not found" });
    if (t.status !== "OPEN")
      return res.status(400).json({ error: "tournament not OPEN" });
    const updated = await prisma.tournament.update({
      where: { id: t.id },
      data: { status: "LOCKED" },
    });
    res.json(updated);
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});

// Commentaire: saisie du bracket (manuel)
app.post("/api/tournaments/:id/matches", async (req, res) => {
  const schema = z.object({
    matches: z.array(
      z.object({
        id: z.string().nullable().optional(),
        round: z.enum(["R64", "R32", "R16", "QF", "SF", "F"]),
        entryAId: z.string().nullable().optional(),
        entryBId: z.string().nullable().optional(),
        nextMatchId: z.string().nullable().optional(),
      })
    ),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.message });

  try {
    const t = await prisma.tournament.findUnique({
      where: { id: req.params.id },
    });
    if (!t) return res.status(404).json({ error: "tournament not found" });
    if (t.status !== "LOCKED" && t.status !== "IN_PROGRESS") {
      return res
        .status(400)
        .json({ error: "tournament must be LOCKED or IN_PROGRESS" });
    }

    const results: any[] = [];
    for (const m of parsed.data.matches) {
      if (m.id) {
        const updated = await prisma.match.update({
          where: { id: m.id },
          data: {
            round: m.round,
            entryAId: m.entryAId || null,
            entryBId: m.entryBId || null,
            nextMatchId: m.nextMatchId || null,
          },
        });
        results.push(updated);
      } else {
        const created = await prisma.match.create({
          data: {
            tournamentId: t.id,
            round: m.round,
            entryAId: m.entryAId || null,
            entryBId: m.entryBId || null,
            nextMatchId: m.nextMatchId || null,
          },
        });
        results.push(created);
      }
    }

    await prisma.tournament.update({
      where: { id: t.id },
      data: { status: "IN_PROGRESS" },
    });
    res.json(results);
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});

// Commentaire: saisie du resultat d un match
app.patch("/api/matches/:id/result", async (req, res) => {
  const schema = z.object({
    setsA: z.number().int().nonnegative(),
    setsB: z.number().int().nonnegative(),
    scoreline: z.string().min(1).optional(),
    winnerEntryId: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.message });

  try {
    const m = await prisma.match.findUnique({
      where: { id: req.params.id },
    });
    if (!m) return res.status(404).json({ error: "match not found" });

    const updated = await prisma.match.update({
      where: { id: m.id },
      data: {
        status: "COMPLETED",
        setsA: parsed.data.setsA,
        setsB: parsed.data.setsB,
        scoreline: parsed.data.scoreline || null,
        winnerEntryId: parsed.data.winnerEntryId,
      },
    });
    res.json(updated);
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});

// Commentaire: termine le tournoi et calcule la distribution pour owner final
app.post("/api/tournaments/:id/finish", async (req, res) => {
  try {
    const t = await prisma.tournament.findUnique({
      where: { id: req.params.id },
      include: { matches: true },
    });
    if (!t) return res.status(404).json({ error: "tournament not found" });
    if (t.status !== "IN_PROGRESS")
      return res
        .status(400)
        .json({ error: "tournament must be IN_PROGRESS" });

    const finals = t.matches.filter(
      (x) => x.round === "F" && x.status === "COMPLETED" && x.winnerEntryId
    );
    const winners = finals.map((x) => x.winnerEntryId!) as string[];
    const entries = await prisma.entry.findMany({
      where: { id: { in: winners } },
    });

    const logs = [];
    for (const e of entries) {
      let finalOwner: string | null = null;
      if (GOLDSKY_ENDPOINT)
        finalOwner = await fetchCurrentOwner(e.contractAddress, e.tokenId);
      finalOwner = finalOwner || "unknown";
      const log = await prisma.distributionLog.create({
        data: {
          tournamentId: t.id,
          entryId: e.id,
          contractAddress: e.contractAddress,
          tokenId: e.tokenId,
          finalOwner,
        },
      });
      logs.push(log);
      console.log(
        "[Distribution]",
        e.id,
        e.contractAddress,
        e.tokenId,
        "owner",
        finalOwner
      );
    }

    const updated = await prisma.tournament.update({
      where: { id: t.id },
      data: { status: "FINISHED" },
    });

    res.json({ tournament: updated, distributions: logs });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});

// -----------------------------------------------------------------------------
// Commentaire: route inline pour fournir les details des packs par id
// -----------------------------------------------------------------------------
app.get("/api/pack-details", async (req, res) => {
  try {
    const idsParam = (req.query.ids as string | undefined) ?? "";
    const ids = idsParam
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n));

    if (ids.length === 0) return res.json([]);

    const rows = await prisma.packInfo.findMany({
      where: { packId: { in: ids } },
      orderBy: { packId: "asc" },
    });

    const map = new Map(rows.map((r) => [r.packId, r]));
    const out = ids.map((id) => {
      const r = map.get(id);
      return r
        ? {
            packId: r.packId,
            name: r.name,
            image: r.image,
            description: r.description,
            playersCount: r.playersCount,
            probCommon: r.probCommon,
            probRare: r.probRare,
            probGold: r.probGold,
            probPlatinum: r.probPlatinum,
            availableAt: r.availableAt ? r.availableAt.toISOString() : null,
          }
        : {
            packId: id,
            name: `Pack #${id}`,
            image: null,
            description: null,
            playersCount: 1,
            probCommon: 0,
            probRare: 0,
            probGold: 0,
            probPlatinum: 0,
            availableAt: null,
          };
    });

    res.json(out);
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});

// ===================== ADD ONLY: routes d auth par wallet =====================
const routerAuth = express.Router();

// Commentaire: utiliser un client Prisma isole pour ne pas impacter le reste
const prismaAuth = new PrismaClient();

// Commentaire: helpers locaux
function toLowerHexAuth(s: string) {
  return (s || "").toLowerCase();
}
function generateReferralCodeAuth() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}
async function generateUniqueReferralCodeAuth() {
  for (let i = 0; i < 12; i++) {
    const code = generateReferralCodeAuth();
    const found = await prismaAuth.userAccount.findUnique({ where: { referralCode: code } });
    if (!found) return code;
  }
  return (generateReferralCodeAuth() + Date.now().toString(36).slice(-2)).toUpperCase();
}

// GET /api/auth/user?address=0x...
routerAuth.get("/user", async (req, res) => {
  try {
    const address = toLowerHexAuth(String(req.query.address || ""));
    if (!address || !address.startsWith("0x")) return res.status(400).json({ error: "invalid address" });
    const user = await prismaAuth.userAccount.findUnique({ where: { address } });
    if (!user) return res.status(404).json({ ok: false });
    res.json({ ok: true, user });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "server error" });
  }
});

// POST /api/auth/register  body: { address, email, username, referral? }
routerAuth.post("/register", async (req, res) => {
  try {
    const { address, email, username, referral } = req.body as {
      address?: string; email?: string; username?: string; referral?: string | null;
    };
    const addr = toLowerHexAuth(address || "");
    if (!addr || !addr.startsWith("0x")) return res.status(400).json({ error: "invalid address" });
    if (!email || !username) return res.status(400).json({ error: "missing email or username" });

    const existing = await prismaAuth.userAccount.findUnique({ where: { address: addr } });
    if (existing) return res.status(200).json({ ok: true, user: existing });

    let referredBy: string | null = null;
    if (typeof referral === "string" && referral.trim()) {
      const sponsor = await prismaAuth.userAccount.findUnique({ where: { referralCode: referral.trim().toUpperCase() } });
      if (sponsor) referredBy = sponsor.referralCode;
    }

    const referralCode = await generateUniqueReferralCodeAuth();
    const created = await prismaAuth.userAccount.create({
      data: { address: addr, email, username, referralCode, referredBy },
    });
    res.status(201).json({ ok: true, user: created });
  } catch (e: any) {
    if ((e as any)?.code === "P2002") return res.status(409).json({ error: "duplicate field", meta: (e as any)?.meta });
    res.status(500).json({ error: e?.message ?? "server error" });
  }
});

// Commentaire: montee du routeur sous /api/auth sans toucher aux autres routes
app.use("/api/auth", routerAuth);
// =================== /ADD ONLY: routes d auth par wallet =====================

// -----------------------------------------------------------------------------
// Commentaire: lancement serveur
// -----------------------------------------------------------------------------
const port = parseInt(process.env.PORT || "4000", 10);
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
