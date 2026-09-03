import { runDraw } from "../keeper/draw.mjs";

export default async function handler(req, res) {
  const cronHeader = req.headers["x-vercel-cron"];
  const auth = req.headers.authorization;
  const secret = process.env.CRON_SECRET;

  if (secret && auth !== `Bearer ${secret}` && cronHeader !== "1") {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const result = await runDraw();
    return res.status(result.ok ? 200 : 400).json(result);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}
