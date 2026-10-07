const { redisRequest, redisPipeline, parseBody, CORS } = require('./_redis');

// =====================================================================
// シーズンの保存庫。
//
// 一斉リセット（SAVE_DATA_VERSION の引き上げ）は、全員のセーブを
// 破棄して0から保存し直す処理そのもの。今日のデータ消失と
// やっていることが同じなので、リセットの「前」に必ず全員ぶんを
// 別のキーへ写し取っておく。
//
// 写したものは2つの役目を持つ。
//   ・殿堂（前シーズンの最終順位）の表示データ
//   ・「前の記録を返してほしい」と言われた時の復元元
//
//  GET  ?action=preview&season=1            … 何件写すかを数えるだけ（無害）
//  GET  ?action=hall&season=1               … 殿堂用。最終順位を返す（公開）
//  GET  ?action=mine&season=1&playerId=…    … 自分の前シーズンのセーブ要約
//  POST { secret, action:'archive', season:1 }  … 実行（要 ADMIN_SECRET）
//  POST { secret, action:'verify',  season:1 }  … 写し終わったか検算
//
// キー構成
//   season:<n>:save:<playerId>   … セーブの完全なコピー
//   season:<n>:hall              … 最終順位（JSON配列）
//   season:<n>:meta              … 実行時刻と件数
// =====================================================================

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SECRET = process.env.ADMIN_SECRET;

  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      const season = seasonOf(q.season);
      const action = q.action || 'preview';

      if (action === 'preview') {
        const ids = await rankedIds();
        const meta = await redisRequest(['get', `season:${season}:meta`]);
        return res.status(200).json({
          success: true, season,
          rankedPlayers: ids.length,
          alreadyArchived: meta.result ? JSON.parse(meta.result) : null,
          adminSecretConfigured: !!SECRET,
        });
      }

      if (action === 'hall') {
        const hall = await redisRequest(['get', `season:${season}:hall`]);
        if (!hall.result) return res.status(404).json({ error: 'No hall for this season', season });
        return res.status(200).json({ success: true, season, hall: JSON.parse(hall.result) });
      }

      if (action === 'mine') {
        if (!q.playerId) return res.status(400).json({ error: 'Missing playerId' });
        const raw = await redisRequest(['get', `season:${season}:save:${q.playerId}`]);
        if (!raw.result) return res.status(404).json({ error: 'No archived save', season });
        let o; try { o = JSON.parse(raw.result); } catch (e) {
          return res.status(500).json({ error: 'Corrupt archive' });
        }
        // 要約だけ返す。完全なセーブは restore-save（要 secret）から。
        return res.status(200).json({
          success: true, season,
          summary: summarize(o),
        });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    if (req.method === 'POST') {
      const body = await parseBody(req);
      if (!SECRET || body.secret !== SECRET) return res.status(403).json({ error: 'Forbidden' });

      const season = seasonOf(body.season);
      const action = body.action || 'archive';

      if (action === 'archive') {
        const ids = await rankedIds();
        if (!ids.length) return res.status(400).json({ error: 'Ranking is empty; nothing to archive' });

        // 1件ずつ読んで写す。件数は多くないので素直にやる。
        const hall = [];
        let copied = 0, missing = 0, broken = 0;
        const writes = [];

        for (const id of ids) {
          const [saveRaw, rankRaw] = await Promise.all([
            redisRequest(['get', `save:${id}`]),
            redisRequest(['get', `player:${id}`]),
          ]);

          let rank = null;
          if (rankRaw.result) { try { rank = JSON.parse(rankRaw.result); } catch (e) {} }

          if (saveRaw.result) {
            let save = null;
            try { save = JSON.parse(saveRaw.result); } catch (e) { broken++; }
            if (save) {
              writes.push(['set', `season:${season}:save:${id}`, saveRaw.result]);
              copied++;
              hall.push(Object.assign({ playerId: id }, summarize(save)));
              continue;
            }
          }
          // セーブが無い／壊れている人も、ランキングの記録だけは殿堂に残す
          missing++;
          hall.push({
            playerId: id,
            playerName: (rank && rank.playerName) || '名無しの船長',
            clickerScore: (rank && rank.clickerScore) || 0,
            reincarnationCount: (rank && rank.reincarnationCount) || 0,
            fragments: (rank && rank.fragments) || 0,
            era: (rank && rank.era) || '江戸時代（初期）',
            saveArchived: false,
          });
        }

        hall.sort((a, b) => (Number(b.clickerScore) || 0) - (Number(a.clickerScore) || 0));
        hall.forEach((h, i) => { h.rank = i + 1; });

        const meta = {
          season,
          archivedAt: Date.now(),
          rankedPlayers: ids.length,
          savesCopied: copied,
          savesMissing: missing,
          savesBroken: broken,
        };
        writes.push(['set', `season:${season}:hall`, JSON.stringify(hall)]);
        writes.push(['set', `season:${season}:meta`, JSON.stringify(meta)]);

        // 書き込みは分割して投げる（1往復に詰め込みすぎない）
        for (let i = 0; i < writes.length; i += 20) {
          await redisPipeline(writes.slice(i, i + 20));
        }

        return res.status(200).json({ success: true, meta, top: hall.slice(0, 10) });
      }

      if (action === 'verify') {
        const metaRaw = await redisRequest(['get', `season:${season}:meta`]);
        if (!metaRaw.result) return res.status(404).json({ error: 'Not archived yet', season });
        const meta = JSON.parse(metaRaw.result);
        const hallRaw = await redisRequest(['get', `season:${season}:hall`]);
        const hall = hallRaw.result ? JSON.parse(hallRaw.result) : [];

        // 殿堂に載っている全員について、写したセーブが本当に読めるか確かめる
        let ok = 0, bad = [];
        for (const h of hall) {
          if (h.saveArchived === false) continue;
          const r = await redisRequest(['get', `season:${season}:save:${h.playerId}`]);
          let good = false;
          if (r.result) {
            try { good = !!JSON.parse(r.result).facilities; } catch (e) { good = false; }
          }
          if (good) ok++; else bad.push(h.playerId);
        }
        return res.status(200).json({
          success: true, season, meta,
          hallEntries: hall.length,
          verifiedSaves: ok,
          failed: bad,
          safeToReset: bad.length === 0 && ok === meta.savesCopied,
        });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (error) {
    console.error('[archive-season]', error.message);
    return res.status(500).json({ error: error.message });
  }
};

async function rankedIds() {
  const r = await redisRequest(['zrevrange', 'ranking', 0, 999]);
  return r.result || [];
}

function seasonOf(v) {
  const n = parseInt(v, 10);
  return (n >= 1 && n <= 99) ? n : 1;
}

function summarize(save) {
  return {
    playerName: save.playerName || '名無しの船長',
    clickerScore: Number(save.clickerScore) || 0,
    reincarnationCount: Number(save.reincarnationCount) || 0,
    superReincarnationCount: Number(save.superReincarnationCount) || 0,
    fragments: Number(save.fragments) || 0,
    sakokuShards: Number(save.sakokuShards) || 0,
    currentEra: save.currentEra || 'edo',
    skillCount: countTrue(save.skills) + countTrue(save.superSkills),
    facilityCount: countFacilities(save.facilities),
    achievementCount: Object.values(save.achievements || {}).filter(a => a && a.unlocked).length,
    ownedSkins: Object.keys(save.ownedSkins || {}).filter(k => save.ownedSkins[k]),
    lastSaveTime: save.lastSaveTime || 0,
    saveArchived: true,
  };
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function countTrue(o) { return (o && typeof o === 'object') ? Object.values(o).filter(Boolean).length : 0; }
function countFacilities(f) {
  if (!f || typeof f !== 'object') return 0;
  return Object.values(f).reduce((s, x) => s + num(x && x.count), 0);
}
