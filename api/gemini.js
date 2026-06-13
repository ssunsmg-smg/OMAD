export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const kakaoKey = process.env.KAKAO_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const { prompt, address, isAnalysis } = req.body;

    // 상권 자동분석 요청일 때만 카카오 API 사용
    let locationContext = '';
    if (isAnalysis && kakaoKey && address) {
      try {
        // 1. 주소 → 좌표 변환
        const geoRes = await fetch(
          `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(address)}`,
          { headers: { Authorization: `KakaoAK ${kakaoKey}` } }
        );
        const geoData = await geoRes.json();
        const doc = geoData.documents?.[0];

        if (doc) {
          const lat = doc.y;
          const lng = doc.x;
          const roadAddr = doc.road_address?.address_name || address;

          // 2. 주변 500m 카테고리별 검색
          const categories = [
            { code: 'FD6', name: '음식점' },
            { code: 'CE7', name: '카페' },
            { code: 'SW8', name: '지하철역' },
            { code: 'OL7', name: '주유소' },
            { code: 'MT1', name: '대형마트' },
            { code: 'CS2', name: '편의점' }
          ];

          const nearbyResults = await Promise.all(
            categories.map(async (cat) => {
              const r = await fetch(
                `https://dapi.kakao.com/v2/local/search/category.json?category_group_code=${cat.code}&x=${lng}&y=${lat}&radius=500&size=5`,
                { headers: { Authorization: `KakaoAK ${kakaoKey}` } }
              );
              const d = await r.json();
              const places = d.documents?.map(p => p.place_name).join(', ') || '없음';
              return `${cat.name}: ${places}`;
            })
          );

          // 3. 키워드로 주변 랜드마크 검색
          const landmarkRes = await fetch(
            `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(address)}&x=${lng}&y=${lat}&radius=1000&size=10`,
            { headers: { Authorization: `KakaoAK ${kakaoKey}` } }
          );
          const landmarkData = await landmarkRes.json();
          const landmarks = landmarkData.documents?.slice(0,5).map(p => `${p.place_name}(${p.category_name})`).join(', ') || '없음';

          locationContext = `
[실제 카카오 지도 데이터]
도로명 주소: ${roadAddr}
좌표: 위도 ${lat}, 경도 ${lng}
반경 500m 내 주요 시설:
${nearbyResults.join('\n')}
반경 1km 내 주요 랜드마크: ${landmarks}
`;
        }
      } catch (kakaoErr) {
        console.error('Kakao API error:', kakaoErr);
        // 카카오 실패해도 계속 진행
      }
    }

    // Claude API 호출
    const finalPrompt = locationContext
      ? `${locationContext}\n\n위 실제 지도 데이터를 바탕으로 분석하세요:\n${prompt}`
      : prompt;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        system: '당신은 OMAD(한영주류 영업팀) 마케팅 콘텐츠 생성기입니다. 반드시 JSON만 반환하고 마크다운 코드블록 없이 순수 JSON만 출력하세요.',
        messages: [{ role: 'user', content: finalPrompt }]
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || '오류' });

    const text = data.content.map(c => c.text || '').join('');
    return res.status(200).json({
      candidates: [{ content: { parts: [{ text }] } }]
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
