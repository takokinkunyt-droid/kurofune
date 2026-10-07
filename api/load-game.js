const { redisRequest, CORS } = require('./_redis');

// セーブの読み出し口。
//
// 直した点：
//  ・以前は Redis の値が壊れていると JSON.parse が例外になり 500 を返していたが、
//    「壊れている」と「存在しない」を区別していなかった。
//    クライアントは 404（データ無し）を「新規プレイヤー」と解釈して
//    0隻から上書きしてしまうので、ここの区別は致命的。
//  ・施設を持たないセーブは壊れているものとして 500 を返し、
//    クライアント側の保存停止（cloudLoadFailed）を働かせる。

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { playerId } = req.query || {};
    if (!playerId) return res.status(400).json({ error: 'Missing playerId' });

    const result = await redisRequest(['get', `save:${playerId}`]);

    if (result.result === null || result.result === undefined) {
      // 本当にキーが無い。ただし履歴が残っているなら「消えた」可能性があるので、
      // 新規扱いにせずエラーで返して自動上書きを止める。
      const hist = await redisRequest(['llen', `save_hist:${playerId}`]);
      if ((hist.result || 0) > 0) {
        console.error('[load-game] save missing but history exists:', playerId);
        return res.status(500).json({
          error: 'Save is missing but history exists', code: 'MISSING_WITH_HISTORY',
        });
      }
      return res.status(404).json({ data: null, message: 'No save found' });
    }

    let saveData;
    try {
      saveData = JSON.parse(result.result);
    } catch (e) {
      console.error('[load-game] corrupt save for', playerId, e.message);
      return res.status(500).json({ error: 'Corrupt save data', code: 'CORRUPT' });
    }

    if (!saveData || typeof saveData !== 'object' || !saveData.facilities) {
      console.error('[load-game] incomplete save for', playerId);
      return res.status(500).json({ error: 'Incomplete save data', code: 'INCOMPLETE' });
    }

    return res.status(200).json({ data: saveData, success: true });
  } catch (error) {
    console.error('[load-game]', error.message);
    return res.status(500).json({ error: error.message });
  }
};
