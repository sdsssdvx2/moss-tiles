-- 2026-11-24 #F-010: signals 를 종류(kind)+시각(t)으로 찾는 쿼리(모의 장부의 AI 점수·뉴스 거부권, 코인 위험 신호)가
-- 기본 키(sym, t, kind)를 못 써서 매번 표 전체(11-24 약 15,300행, etf_nav 가 매일 늘어남)를 훑었다. D1 무료 읽기 한도(계정 하루 500만 행)의 대부분.
CREATE INDEX IF NOT EXISTS signals_kind_t ON signals (kind, t);
