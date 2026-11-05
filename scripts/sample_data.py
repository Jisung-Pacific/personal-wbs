#!/usr/bin/env python3
"""Generate a synthetic sample ledger in English and Korean (schema v6).

Usage:
  python3 sample_data.py [--out DIR] [--seed N]

Writes DIR/en and DIR/ko (default DIR: sample/ next to this scripts folder), each
with wbs.csv, coverage.csv, plan.csv and events.csv. Both versions come from one
spec, so codes, dates and numbers match; only the language differs.

The persona is fictional: a master's student who is applying for PhD programs and
runs a small study-habit app ("Sproutlog"). Nothing here describes a real person.
Output is deterministic for a given seed. Reference date (as of): 2026-11-06; the
persona built the ledger on 2026-09-14, so earlier events are marked estimated.
"""
import argparse
import datetime as dt
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wbs_schema as S  # noqa: E402

AS_OF = dt.date(2026, 11, 6)
BOOTSTRAP = dt.date(2026, 9, 14)
LANGS = ('en', 'ko')

AREAS = {'1': ('Research', '연구'), '2': ('Graduate School', '진학'), '3': ('Startup', '창업·제품'),
         '4': ('Career', '대외·경력'), '5': ('Admin', '개인 행정')}
GOALS = {  # key: (en name, ko name, en note, ko note)
    'msc': ('Finish the MSc', '석사 학위 마무리',
            'Thesis defended and submitted by the end of 2026', '2026년 말까지 학위논문 심사·제출'),
    'phd': ('PhD admission for 2027', '2027년 박사 과정 합격',
            'An offer from at least one target program', '목표 프로그램 1곳 이상 합격'),
    'pub': ('Publish the research', '연구 성과 출판',
            'One workshop paper, one main-track paper, a journal extension submitted',
            '워크숍 1편, 본 학회 1편, 저널 확장 투고'),
    'app': ('Grow Sproutlog', 'Sproutlog 성장',
            '1,000 weekly active users with a sustainable routine', '주간 활성 사용자 1,000명과 지속 가능한 운영'),
    'admin': ('Admin on time', '행정 기한 준수',
              'No missed enrollment, tax or paperwork deadlines', '학적·세무·서류 기한 누락 없음'),
}


def T(en, ko, start=None, size='S', **kw):
    """One task or step. kw: st (status, default done), end, last, due, imp, kr, key, deps,
    blk (category, en, ko), goal, ev, steps, gpt, planned, undated, logged, recon, move, correct, retired."""
    return dict(en=en, ko=ko, start=start, size=size, **kw)


# ------------------------------------------------------------------ templates for routine work
READING = [('time-series anomaly detection', '시계열 이상 탐지'), ('TinyML deployment', 'TinyML 배포'),
           ('battery degradation models', '배터리 열화 모델'), ('contrastive learning for time series', '시계열 대조 학습'),
           ('conformal prediction', '컨포멀 예측'), ('anomaly-detection evaluation metrics', '이상 탐지 평가 지표'),
           ('concept drift', '개념 드리프트'), ('on-device continual learning', '기기 내 지속 학습'),
           ('sensor data augmentation', '센서 데이터 증강')]
SEMINAR = [('a transformer-based anomaly detector', '트랜스포머 기반 이상 탐지기'),
           ('self-supervised pretraining for sensors', '센서 자기지도 사전학습'),
           ('model compression for microcontrollers', '마이크로컨트롤러용 모델 경량화'),
           ('drift-aware evaluation', '드리프트를 고려한 평가'), ('uncertainty estimation', '불확실성 추정'),
           ('benchmark leakage pitfalls', '벤치마크 누수 문제'), ('federated learning on devices', '기기 내 연합학습'),
           ('streaming anomaly detection', '스트리밍 이상 탐지')]
BUGS = [('streak reset at midnight in other time zones', '다른 시간대에서 자정에 연속 기록이 초기화됨'),
        ('duplicate reminders after an app update', '앱 업데이트 후 알림 중복'),
        ('sync conflict when editing on two devices', '두 기기에서 동시에 고칠 때 동기화 충돌'),
        ('crash on the weekly review of an empty week', '빈 주의 주간 회고 화면에서 충돌'),
        ('widget not refreshing after a check-in', '체크인 후 위젯이 갱신되지 않음'),
        ('slow start-up on older phones, 2.8 s to 1.1 s', '구형 기기 실행 지연 개선, 2.8초에서 1.1초로'),
        ('wrong week start for Monday-first locales', '월요일 시작 지역에서 주 시작일 오류'),
        ('invite links expiring too early', '초대 링크가 너무 일찍 만료됨'),
        ('dark text on a dark background in settings', '설정 화면에서 어두운 배경에 어두운 글자')]
INSIGHTS = [('students plan on Sunday evenings', '학생들은 일요일 저녁에 계획을 세움'),
            ('streak pressure makes some users quit', '연속 기록 압박으로 그만두는 사용자가 있음'),
            ('group accountability works better than reminders', '알림보다 그룹 책임감이 효과적'),
            ('exam weeks break routines', '시험 기간에 루틴이 무너짐')]
SUBS = [('reference manager', '참고문헌 관리 도구', 'renewed on the student plan', '학생 요금제로 갱신'),
        ('cloud GPU credits', '클라우드 GPU 크레딧', 'switched to the department cluster', '학과 클러스터로 전환'),
        ('note-taking app', '노트 앱', 'cancelled, notes moved to plain Markdown', '해지, 노트를 일반 Markdown으로 이전'),
        ('design tool', '디자인 도구', 'kept the free plan', '무료 요금제 유지'),
        ('app store developer account', '앱 스토어 개발자 계정', 'renewed for the business', '사업용으로 갱신'),
        ('domain and mail hosting', '도메인·메일 호스팅', 'renewed for 2 years', '2년 갱신')]
DS, ML = ('Data Structures', '자료구조'), ('Machine Learning', '기계학습')


def on(rng, year, month, lo=2, hi=26):
    return dt.date(year, month, rng.randint(lo, hi)).isoformat()


def reading(rng, year, months, first):
    out = []
    for i, m in enumerate(months):
        en, ko = READING[(first + i) % len(READING)]
        n = rng.randint(5, 12)
        out.append(T(f'Reading notes: {n} papers on {en}, summary and comparison table',
                     f'문헌 정리: {ko} 논문 {n}편 요약과 비교표', on(rng, year, m), 'M'))
    return out


def seminars(rng, year, months, first):
    out = []
    for i, m in enumerate(months):
        en, ko = SEMINAR[(first + i) % len(SEMINAR)]
        n = rng.randint(14, 30)
        out.append(T(f'Lab seminar talk: review of {en}, {n} slides', f'연구실 세미나 발표: {ko} 리뷰, 슬라이드 {n}장',
                     on(rng, year, m), 'S', ev=['claude', 'cal']))
    return out


def grading(rng, year, course, months, first_k):
    out = []
    for i, m in enumerate(months):
        n = rng.randint(38, 64)
        out.append(T(f'{course[0]}: assignment {first_k + i} graded, {n} submissions with written feedback',
                     f'{course[1]} 과제 {first_k + i} 채점: 제출 {n}건, 서면 피드백', on(rng, year, m), 'M', goal=''))
    return out


def labs(rng, year, course, weeks):
    out = []
    for w, m in weeks:
        n = rng.randint(24, 40)
        out.append(T(f'{course[0]}: week-{w} lab session run for {n} students',
                     f'{course[1]} {w}주차 실습 진행: 학생 {n}명', on(rng, year, m), 'S', one_day=True,
                     goal='', ev=['cal']))
    return out


def bugfixes(rng, year, months, first, issue):
    out = []
    for i, m in enumerate(months):
        en, ko = BUGS[(first + i) % len(BUGS)]
        issue += rng.randint(3, 9)
        out.append(T(f'Bug fix: {en} (issue #{issue})', f'버그 수정: {ko} (이슈 #{issue})', on(rng, year, m), 'S',
                     ev=[f'gh:example/sproutlog#{issue}']))
    return out


def metrics(rng, year, months, wau, step):
    out = []
    for m in months:
        wau += rng.randint(step // 2, step)
        r = rng.randint(24, 41)
        out.append(T(f'Weekly metrics review: {wau} weekly active users, {r}% day-7 retention',
                     f'주간 지표 점검: 주간 활성 사용자 {wau}명, 7일 유지율 {r}%', on(rng, year, m), 'S', one_day=True))
    return out


def interviews(rng, year, months, first):
    out = []
    for i, m in enumerate(months):
        en, ko = INSIGHTS[(first + i) % len(INSIGHTS)]
        n = rng.randint(4, 8)
        out.append(T(f'User interviews ({n}): {en}', f'사용자 인터뷰 {n}건: {ko}', on(rng, year, m), 'M'))
    return out


def subscriptions(rng, year, months, first):
    out = []
    for i, m in enumerate(months):
        en, ko, den, dko = SUBS[(first + i) % len(SUBS)]
        out.append(T(f'Subscription review: {en}, {den}', f'구독 점검: {ko}, {dko}', on(rng, year, m), 'S',
                     imp='low', one_day=True))
    return out


def bookkeeping(rng, year, q, month, **kw):
    n = rng.randint(12, 31)
    return T(f'Q{q} bookkeeping: {n} receipts filed, ledger reconciled', f'{q}분기 장부 정리: 증빙 {n}건, 장부 대사',
             on(rng, year, month), 'S', **kw)


# ------------------------------------------------------------------ the ledger spec
def spec(rng):
    """{year: [(package code, en name, ko name, default goal key, [tasks])]}"""
    y25 = [
        ('1.1', 'Thesis experiments', '학위논문 실험', 'msc', [
            T('Experiment pipeline: loaders for 3 battery datasets, YAML configs, fixed seeds',
              '실험 파이프라인: 배터리 데이터셋 3종 로더, YAML 설정, 시드 고정', '2025-02-10', 'M',
              key='pipe', ev=['claude', 'commit:anomaly-bench']),
            T('Baseline reproduction: 4 detectors (Isolation Forest, LOF, autoencoder, LSTM-AE), F1 0.61 to 0.74',
              '베이스라인 재현: 탐지기 4종(Isolation Forest, LOF, 오토인코더, LSTM-AE), F1 0.61~0.74', '2025-03-03', 'M',
              key='base', deps=['pipe']),
            T('Proposed detector v1: lightweight temporal convolution, F1 0.79 on dataset A',
              '제안 탐지기 v1: 경량 시간 합성곱, 데이터셋 A에서 F1 0.79', '2025-04-01', 'L',
              key='det1', deps=['base'], ev=['claude', 'commit:anomaly-bench']),
            T('Hyperparameter search: 120 trials on dataset B, best window length 256',
              '하이퍼파라미터 탐색: 데이터셋 B에서 120회, 최적 윈도 길이 256', '2025-05-12', 'S', gpt=True),
            T('Ablation study: 5 components removed one at a time, largest drop 0.09 F1',
              '절제 실험: 구성요소 5개를 하나씩 제거, 최대 F1 하락 0.09', '2025-06-02', 'M', deps=['det1']),
            T('Cross-dataset test: trained on A, tested on B and C, F1 down by 0.12',
              '교차 데이터셋 시험: A로 학습해 B·C에서 평가, F1 0.12 하락', '2025-07-07', 'M'),
            T('Noise robustness test: 3 noise levels, 11 failure cases catalogued',
              '잡음 강건성 시험: 잡음 3단계, 실패 사례 11건 정리', '2025-08-04', 'M'),
            T('Edge benchmark on a single-board computer: 4.1 ms per window, 38 MB peak memory',
              '싱글보드 컴퓨터 엣지 벤치마크: 윈도당 4.1 ms, 최대 메모리 38 MB', '2025-09-08', 'S'),
            T('Experiment log cleanup: 46 runs relabelled, results table v2',
              '실험 기록 정리: 실행 46건 재라벨링, 결과표 v2', '2025-10-06', 'S',
              ev=['claude', ('drive', 'Results table v2', '결과표 v2')]),
            T('Thesis proposal defence passed with 3 required revisions', '학위논문 계획 심사 통과 (수정 요구 3건)',
              '2025-11-13', 'S', one_day=True, kr=True, imp='high', due='2025-11-13', key='prop', ev=['claude', 'cal']),
            T('Proposal revisions: related-work scope narrowed, one baseline added',
              '계획 심사 수정: 관련연구 범위 축소, 베이스라인 1개 추가', '2025-12-01', 'M', deps=['prop'],
              move=('2026-09-15', 'continued as 2026:1.1.1', '2026:1.1.1로 이어짐')),
        ]),
        ('1.2', 'Workshop paper', '워크숍 논문', 'pub', [
            T('Workshop paper: lightweight anomaly detection for battery sensors',
              '워크숍 논문: 배터리 센서용 경량 이상 탐지', size='L', kr=True, key='ws', steps=[
                  T('First full draft, 6 pages', '초고 완성 (6쪽)', '2025-07-14', 'M',
                    ev=['claude', ('drive', 'Workshop paper draft v1', '워크숍 논문 초고 v1')]),
                  T('Lab internal review: 14 comments resolved', '연구실 내부 검토: 의견 14건 반영', '2025-08-11', 'S'),
                  T('Submitted to the ML-for-systems workshop', 'ML 시스템 워크숍 투고', '2025-08-28', 'S',
                    one_day=True, due='2025-08-29', imp='high'),
                  T('Acceptance notification: 3 of 3 reviewers positive', '채택 통보: 심사위원 3명 모두 긍정',
                    '2025-10-01', 'S', one_day=True, ev=['gmail']),
                  T('Camera-ready version submitted', '최종본 제출', '2025-10-09', 'S', due='2025-10-15'),
                  T('Poster presented at the workshop, 30+ visitors', '워크숍 포스터 발표, 방문자 30명 이상',
                    '2025-12-08', 'S', one_day=True, ev=['claude', 'cal'])]),
            T('Code release: public repository with README and 3 reproduction scripts',
              '코드 공개: README와 재현 스크립트 3개를 갖춘 공개 저장소', '2025-10-20', 'S',
              ev=['gh:example/anomaly-bench#3']),
            T('A0 poster and 3-minute pitch script', 'A0 포스터와 3분 발표 대본', '2025-11-24', 'M'),
        ]),
        ('1.3', 'Literature review', '문헌 조사', 'msc', [
            *reading(rng, 2025, (2, 3, 4), 0),
            T('Survey table: 48 papers classified by method, dataset and metric',
              '조사표: 논문 48편을 방법·데이터셋·지표로 분류', '2025-05-19', 'M',
              ev=['claude', ('drive', 'Survey table', '조사표')]),
            *reading(rng, 2025, (6, 8, 10), 3),
        ]),
        ('1.4', 'Lab seminar', '연구실 세미나', 'msc', seminars(rng, 2025, (3, 4, 5, 6, 9, 10, 11), 0)),
        ('2.1', 'Application preparation', '진학 준비', 'phd', [
            T('English test registration and 4-week study plan', '영어 시험 접수와 4주 학습 계획', '2025-06-09', 'S'),
            T('English test taken', '영어 시험 응시', '2025-07-12', 'S', one_day=True, ev=['cal']),
            T('English test score received: meets the minimum of all 5 target programs',
              '영어 시험 성적 수령: 목표 프로그램 5곳의 최저 기준 모두 충족', '2025-07-25', 'S', one_day=True,
              ev=['gmail']),
            T('Program shortlist: 9 programs compared on 6 criteria, 5 chosen',
              '지원 프로그램 선정: 9곳을 6개 기준으로 비교해 5곳 확정', '2025-08-18', 'M', key='short'),
            T('Academic CV v1, 2 pages', '학술 이력서 v1 (2쪽)', '2025-09-15', 'S',
              ev=['claude', ('drive', 'Academic CV v1', '학술 이력서 v1')]),
            T('Statement of purpose outline v1', '학업계획서 개요 v1', '2025-10-13', 'S'),
            T('Research statement draft v1, 2 pages', '연구계획서 초안 v1 (2쪽)', '2025-11-17', 'M', gpt=True),
        ]),
        ('2.2', 'Advisor outreach', '지도교수 컨택', 'phd', [
            T('Prospective advisor list: 12 labs with publication-fit notes',
              '희망 지도교수 목록: 연구실 12곳과 연구 적합도 메모', '2025-09-01', 'M', deps=['short']),
            T('Outreach e-mails sent to 6 faculty members', '교수 6명에게 컨택 메일 발송', '2025-10-01', 'S',
              one_day=True, ev=['claude', 'gmail']),
            T('Video call with a faculty member at University A: possible fit for the 2027 intake',
              'A대학 교수와 화상 면담: 2027년 입학 가능성 확인', '2025-11-05', 'S', one_day=True, ev=['cal']),
            T('Workshop paper and research plan sent to 2 labs', '워크숍 논문과 연구계획을 연구실 2곳에 공유',
              '2025-12-10', 'S', one_day=True, deps=['ws'], ev=['gmail']),
        ]),
        ('3.1', 'Sproutlog MVP', 'Sproutlog MVP', 'app', [
            T('Problem interviews with 15 students: the top pain is planning, not tracking',
              '학생 15명 문제 인터뷰: 가장 큰 불편은 기록이 아니라 계획', '2025-05-06', 'M', key='prob'),
            T('Landing page with a waitlist form', '대기자 신청 양식이 있는 랜딩 페이지', '2025-06-02', 'S',
              ev=['gh:example/sproutlog#2']),
            T('MVP build: check-ins, streaks and weekly review', 'MVP 개발: 체크인, 연속 기록, 주간 회고',
              size='L', key='mvp', deps=['prob'], steps=[
                  T('Data model and offline-first sync design document', '데이터 모델과 오프라인 우선 동기화 설계 문서',
                    '2025-06-16', 'M', ev=['claude', ('drive', 'Sync design', '동기화 설계')]),
                  T('Habit check-in screen with streaks', '습관 체크인 화면과 연속 기록', '2025-07-01', 'M',
                    ev=['gh:example/sproutlog#9']),
                  T('Weekly review screen', '주간 회고 화면', '2025-07-21', 'M', ev=['gh:example/sproutlog#14']),
                  T('Internal alpha build shared with 8 testers', '내부 알파 빌드를 테스터 8명에게 배포',
                    '2025-08-11', 'S', one_day=True)]),
            T('Analytics event plan: 18 events, no personal data collected',
              '분석 이벤트 설계: 18개, 개인정보 수집 없음', '2025-08-18', 'S'),
            T('Waitlist reached 210 sign-ups', '대기자 210명 달성', '2025-09-01', 'S', one_day=True),
            T('Android port feasibility study', '안드로이드 이식 타당성 검토', '2025-09-22', 'S', st='backlog',
              last='2025-10-03', blk=('on_hold', 'until v1 is stable', 'v1 안정화 이후')),
        ]),
        ('3.2', 'Beta test', '베타 테스트', 'app', [
            T('Closed beta v0.9 released to 64 testers', '비공개 베타 v0.9를 테스터 64명에게 배포', '2025-09-15', 'S',
              one_day=True, deps=['mvp'], ev=['gh:example/sproutlog#21']),
            T('Beta stability report: 97.8% crash-free sessions over 3 weeks',
              '베타 안정성 보고: 3주간 무충돌 세션 97.8%', '2025-10-06', 'S'),
            *bugfixes(rng, 2025, (9, 10, 11, 12), 0, 22),
            *metrics(rng, 2025, (10, 11, 12), 34, 10),
            *interviews(rng, 2025, (10, 11), 0),
            T('Beta feedback synthesis: 112 items grouped into 9 themes', '베타 피드백 정리: 112건을 9개 주제로 분류',
              '2025-11-10', 'M', key='fb'),
            T('v1 roadmap: 9 themes ranked, 4 chosen for the launch', 'v1 로드맵: 9개 주제 우선순위, 출시 범위 4개 확정',
              '2025-11-24', 'S', key='roadmap', deps=['fb'], gpt2=True),
        ]),
        ('3.3', 'Startup programs', '창업 지원 프로그램', 'app', [
            T('University startup program application submitted', '교내 창업 프로그램 지원서 제출', '2025-07-07', 'M',
              end='2025-07-09', due='2025-07-11'),
            T('Selected for the university startup program, 1 of 12 teams', '교내 창업 프로그램 선정 (12팀 중 1팀)',
              '2025-08-04', 'S', one_day=True, kr=True, ev=['gmail']),
            T('Startup program completed: 6 weekly workshops', '창업 프로그램 수료: 주간 워크숍 6회', '2025-10-10', 'S',
              one_day=True),
            T('Demo day pitch: 5 minutes, 2 follow-up meetings booked', '데모데이 피치: 5분, 후속 미팅 2건 확정',
              '2025-11-20', 'S', one_day=True, ev=['claude', 'cal']),
        ]),
        ('4.1', 'Teaching assistant', '조교', '', [
            T('TA onboarding and course site setup for Data Structures', '자료구조 조교 오리엔테이션과 강의 사이트 설정',
              '2025-02-24', 'S'),
            *grading(rng, 2025, DS, (3, 4, 5), 1),
            *labs(rng, 2025, DS, ((2, 3), (6, 4))),
            *grading(rng, 2025, ML, (9, 10, 11), 1),
            *labs(rng, 2025, ML, ((3, 9), (8, 10))),
        ]),
        ('4.2', 'Talks and networking', '발표·네트워킹', '', [
            T('Regional ML meetup attended, 2 follow-up conversations', '지역 ML 밋업 참석, 후속 대화 2건', '2025-04-17',
              'S', one_day=True, ev=['cal']),
            T('Lightning talk at a student hackathon, 5 minutes', '학생 해커톤 라이트닝 토크 (5분)', '2025-05-24', 'S',
              one_day=True, ev=['claude', 'cal']),
            T('Capstone mentoring for 2 undergraduate teams', '학부 캡스톤 2팀 멘토링', size='L', steps=[
                T('Kick-off meetings with both teams', '두 팀과 착수 회의', '2025-09-08', 'S', one_day=True, ev=['cal']),
                T('Mid-term design review: written feedback for both teams', '중간 설계 검토: 두 팀에 서면 피드백',
                  '2025-10-20', 'S'),
                T('Final demo feedback and proposed grades', '최종 시연 피드백과 성적 제안', '2025-12-04', 'S',
                  one_day=True)]),
        ]),
        ('5.1', 'Enrollment and paperwork', '학적·서류', 'admin', [
            T('Spring semester registration: 3 courses', '1학기 수강 등록: 3과목', '2025-02-17', 'S'),
            T('Research ethics training certificate', '연구윤리 교육 이수증', undated=True),
            T('GPU workstation access request approved', 'GPU 워크스테이션 사용 신청 승인', '2025-03-17', 'S',
              one_day=True, ev=['gmail']),
            T('Fall semester registration: 2 courses and thesis credits', '2학기 수강 등록: 2과목과 논문 학점',
              '2025-08-18', 'S'),
        ]),
        ('5.2', 'Tools and subscriptions', '장비·구독', 'admin', [
            *subscriptions(rng, 2025, (1,), 0),
            T('Backup routine for thesis data: 3 copies, 2 media, 1 off-site',
              '학위 데이터 백업 체계: 사본 3개, 매체 2종, 외부 1곳', '2025-04-07', 'S'),
            *subscriptions(rng, 2025, (6, 11), 1),
        ]),
        ('5.3', 'Tax and bookkeeping', '세무·회계', 'admin', [
            T('Sproutlog registered as a sole-proprietor business', 'Sproutlog 개인사업자 등록', '2025-07-21', 'S',
              one_day=True, kr=True),
            T('Bookkeeping template: income and expense ledger with a receipt folder',
              '장부 양식: 수입·지출 장부와 증빙 폴더', '2025-07-28', 'S'),
            bookkeeping(rng, 2025, 3, 10),
            T('Year-end tax document checklist, 11 items', '연말 세무 서류 체크리스트 (11개 항목)', '2025-12-15', 'S'),
        ]),
    ]

    y26 = [
        ('1.1', 'Thesis writing', '학위논문 집필', 'msc', [
            T(f"{S.CONTINUED['en']} Thesis outline v2 approved by the advisor",
              f"{S.CONTINUED['ko']} 학위논문 목차 v2 지도교수 승인", '2026-01-12', 'S', one_day=True),
            T('Chapter 2 related work, 28 pages', '2장 관련연구 28쪽', '2026-01-19', 'L'),
            T('Chapter 3 method, 22 pages and 9 figures', '3장 방법 22쪽, 그림 9개', '2026-02-16', 'L'),
            T('Chapter 4 experiments re-run with fixed seeds on 5 datasets',
              '4장 실험: 데이터셋 5종에서 시드 고정 재실험', '2026-04-06', 'L', ev=['claude', 'commit:anomaly-bench']),
            T('Chapter 5 discussion and limitations', '5장 논의와 한계', '2026-06-01', 'M'),
            T('Full draft v1 sent to the advisor, 118 pages', '전체 초고 v1 지도교수 제출 (118쪽)', '2026-07-06', 'S',
              one_day=True, due='2026-07-10', ev=['claude', ('drive', 'Thesis full draft v1', '학위논문 전체 초고 v1')]),
            T('Revision round 1: 63 comments resolved', '1차 수정: 의견 63건 반영', '2026-08-03', 'L'),
            T('Thesis defence passed with minor revisions', '학위논문 심사 통과 (경미한 수정 조건)', '2026-10-14', 'S',
              one_day=True, kr=True, imp='high', due='2026-10-14', key='defence', ev=['claude', 'cal']),
            T('Final thesis with the defence revisions, 7 of 12 done', '심사 수정사항을 반영한 학위논문 최종본, 12건 중 7건 반영',
              '2026-10-19', 'M', st='in_progress', last='2026-11-04', due='2026-11-27', imp='high',
              key='final', deps=['defence']),
            T('Thesis repository submission', '학위논문 저장소 제출', planned=True, st='waiting', logged='2026-10-19',
              due='2026-11-30', imp='high', deps=['final'],
              blk=('prerequisite', 'final thesis ({dep})', '학위논문 최종본 ({dep})')),
        ]),
        ('1.2', 'Conference paper', '학회 논문', 'pub', [
            T('Main-track conference paper: anomaly detection under sensor drift',
              '본 학회 논문: 센서 드리프트 환경의 이상 탐지', size='XL', key='conf', steps=[
                  T('Experiments frozen: 5 datasets and 6 baselines', '실험 동결: 데이터셋 5종, 베이스라인 6종',
                    '2026-02-02', 'M'),
                  T('Draft v1, 9 pages', '초고 v1 (9쪽)', '2026-03-09', 'L'),
                  T('Submitted to the main track', '본 학회 투고', '2026-05-13', 'S', one_day=True, due='2026-05-15',
                    imp='high'),
                  T('Rebuttal submitted: 4 reviewers, 11 points answered', '반박문 제출: 심사위원 4명, 쟁점 11개 답변',
                    '2026-08-03', 'M', due='2026-08-07'),
                  T('Final decision from the program committee', '프로그램 위원회 최종 결과', '2026-08-08', 'S',
                    st='waiting', last='2026-08-08',
                    blk=('external_review', 'program committee', '프로그램 위원회'))]),
            T('Supplementary material: 14-page appendix', '보충 자료: 14쪽 부록', '2026-05-04', 'M'),
            T('Preprint posted with a code link', '프리프린트 공개와 코드 링크', '2026-05-20', 'S', one_day=True),
        ]),
        ('1.3', 'Journal extension', '저널 확장', 'pub', [
            T('Extension plan: 3 new experiments, about 40% new material', '확장 계획: 신규 실험 3개, 신규 분량 약 40%',
              '2026-09-07', 'S', key='ext', deps=['ws', 'conf']),
            T('Streaming-setting experiments', '스트리밍 설정 실험', size='L', deps=['ext'], due='2026-12-18', steps=[
                T('Streaming experiments on dataset A', '데이터셋 A 스트리밍 실험', '2026-09-21', 'L', end='2026-10-02',
                  ev=['commit:anomaly-bench']),
                T('Streaming experiments on dataset B', '데이터셋 B 스트리밍 실험', '2026-10-05', 'L', end='2026-10-16',
                  ev=['commit:anomaly-bench']),
                T('Streaming experiments on dataset C', '데이터셋 C 스트리밍 실험', '2026-10-26', 'L', st='in_progress',
                  last='2026-11-03', due='2026-12-18', ev=['claude', 'commit:anomaly-bench'])]),
            T('Related-work update: 19 new papers', '관련연구 갱신: 신규 논문 19편', '2026-10-12', 'M',
              st='in_progress', last='2026-10-22'),
            T('Survey paper on lightweight anomaly detection', '경량 이상 탐지 서베이 논문', '2026-09-28', 'M',
              st='backlog', last='2026-10-05',
              blk=('on_hold', 'after the PhD applications', '박사 지원 이후')),
        ]),
        ('1.4', 'Lab seminar', '연구실 세미나', 'msc', [
            *seminars(rng, 2026, (3, 4, 5, 9, 10), 2),
            T('Lab seminar talk: review of streaming anomaly detection, slides in progress',
              '연구실 세미나 발표: 스트리밍 이상 탐지 리뷰, 슬라이드 작성 중', '2026-11-02', 'S', st='in_progress',
              last='2026-11-05', due='2026-11-12'),
        ]),
        ('1.5', 'Literature review', '문헌 조사', 'pub', reading(rng, 2026, (1, 6, 9), 6)),
        ('2.1', 'PhD applications', '박사 지원', 'phd', [
            T('Target list updated: 6 programs, deadlines from Dec 1 to Jan 15',
              '지원 목록 갱신: 6개 프로그램, 마감 12월 1일~1월 15일', '2026-09-01', 'S', deps=['short']),
            T('Statement of purpose v3, 1,000 words', '학업계획서 v3 (1,000단어)', '2026-09-14', 'M', key='sop',
              ev=['claude', ('drive', 'Statement of purpose v3', '학업계획서 v3')]),
            T('Recommendation requests sent to 3 recommenders through the application portals',
              '지원 포털로 추천인 3명에게 추천서 요청 발송', '2026-10-05', 'S', st='waiting', last='2026-10-20',
              due='2026-11-25', imp='high', key='rec',
              blk=('external_reply', '1 of 3 recommenders (internship supervisor)', '추천인 3명 중 1명 (인턴십 지도 담당자)')),
            T('Applications to 4 programs', '4개 프로그램 지원', size='XL', imp='high', steps=[
                T('University A application submitted', 'A대학 지원서 제출', '2026-10-19', 'M', end='2026-10-28',
                  due='2026-11-01', deps=['sop'], ev=['claude', ('drive', 'University A application', 'A대학 지원서')]),
                T('University B application: forms and tailored statement', 'B대학 지원서: 양식과 맞춤 학업계획서',
                  '2026-10-26', 'M', st='in_progress', last='2026-11-05', due='2026-12-01'),
                T('University C application', 'C대학 지원서', '2026-11-02', 'M', st='waiting', last='2026-11-02',
                  due='2026-12-15', deps=['rec'],
                  blk=('prerequisite', 'recommendation letters ({dep})', '추천서 ({dep})')),
                T('University D application', 'D대학 지원서', '2026-10-07', 'S', st='backlog', last='2026-10-12',
                  blk=('on_hold', 'deadline clashes with the thesis defence', '마감이 학위논문 심사와 겹침'))]),
            T('Interview preparation: 20 question cards and a 5-minute research pitch',
              '면접 준비: 질문 카드 20장과 5분 연구 소개', '2026-11-02', 'M', st='in_progress', last='2026-11-04'),
            T('Transcripts and expected-graduation letter issued', '성적증명서와 졸업예정증명서 발급', '2026-10-13', 'S',
              one_day=True),
            T('Writing sample chosen and formatted: the workshop paper, 6 pages', '작문 샘플 선정과 서식 정리: 워크숍 논문 6쪽',
              '2026-11-03', 'S', one_day=True, deps=['ws']),
        ]),
        ('2.2', 'Scholarships', '장학금', 'phd', [
            T('Department travel grant approved for the summer school', '여름학교 참가 학과 출장 지원 승인',
              '2026-05-25', 'S', one_day=True, key='travel', ev=['gmail']),
            T('External PhD scholarship application submitted', '외부 박사 장학금 지원서 제출', '2026-09-21', 'M',
              end='2026-09-25', due='2026-09-30', key='schol'),
            T('Scholarship decision', '장학금 결과', '2026-09-30', 'S', st='waiting', last='2026-09-30', deps=['schol'],
              blk=('external_review', 'scholarship committee', '장학 심사위원회')),
        ]),
        ('3.1', 'Sproutlog releases', 'Sproutlog 출시·배포', 'app', [
            T('v1.0 public launch', 'v1.0 정식 출시', size='XL', kr=True, key='launch', deps=['roadmap'], steps=[
                T('Feature freeze and QA: 42 test cases passed', '기능 동결과 QA: 테스트 케이스 42개 통과',
                  '2026-01-12', 'M'),
                T('Store listing: screenshots, description, privacy labels', '스토어 등록 정보: 스크린샷, 설명, 개인정보 라벨',
                  '2026-02-02', 'S'),
                T('First store submission rejected: no in-app account deletion', '스토어 1차 심사 반려: 앱 내 계정 삭제 기능 없음',
                  '2026-02-05', 'S', one_day=True),
                T('In-app account deletion', '앱 내 계정 삭제 기능', '2026-02-09', 'M', ev=['gh:example/sproutlog#48']),
                T('Store review passed on the second submission', '스토어 2차 심사 통과', '2026-02-16', 'S',
                  one_day=True),
                T('Public launch on both app stores', '두 앱 스토어에 정식 출시', '2026-03-02', 'S', one_day=True,
                  due='2026-03-02', correct=('2026-09-21', 'end date corrected from the store record (was 2026-03-03)',
                                             '스토어 기록으로 종료일 정정 (기존 2026-03-03)'))]),
            T('Launch posts in 4 student communities', '학생 커뮤니티 4곳에 출시 글 게시', '2026-03-03', 'S',
              one_day=True),
            *bugfixes(rng, 2026, (3, 4), 4, 52),
            T('v1.1 release: reminders and a home-screen widget', 'v1.1 배포: 알림과 홈 화면 위젯', '2026-04-06', 'M',
              ev=['gh:example/sproutlog#63']),
            T('v1.2 release: study-group sharing with invite links and shared streaks',
              'v1.2 배포: 초대 링크와 공동 연속 기록을 갖춘 스터디 그룹 공유', '2026-05-04', 'L',
              ev=['gh:example/sproutlog#71']),
            T('Dark mode', '다크 모드', '2026-06-15', 'S', st='backlog', last='2026-06-20',
              blk=('on_hold', 'after v1.3', 'v1.3 이후')),
            *bugfixes(rng, 2026, (6, 8, 10), 6, 74),
            T('v1.3 offline mode', 'v1.3 오프라인 모드', size='L', imp='high', due='2026-11-20', steps=[
                T('Offline storage layer and sync conflict rules', '오프라인 저장 계층과 동기화 충돌 규칙', '2026-09-14',
                  'L', end='2026-10-02', ev=['gh:example/sproutlog#88']),
                T('Offline UI states and error messages', '오프라인 UI 상태와 오류 메시지', '2026-10-12', 'M',
                  st='in_progress', last='2026-11-01', due='2026-11-13', key='v13ui'),
                T('Beta build for 20 testers', '테스터 20명용 베타 빌드', planned=True, st='waiting', logged='2026-10-12',
                  deps=['v13ui'], blk=('prerequisite', 'offline UI ({dep})', '오프라인 UI ({dep})'))]),
        ]),
        ('3.2', 'Growth and operations', '성장·운영', 'app', [
            T('First-week report: 1,240 installs, 38% day-1 retention', '첫 주 보고: 설치 1,240건, 1일 유지율 38%',
              '2026-03-09', 'S', one_day=True),
            T('Privacy policy updated for the new analytics events', '신규 분석 이벤트를 반영해 개인정보 처리방침 개정',
              '2026-04-13', 'S'),
            T('Support inbox routine: triage twice a week with reply templates', '문의함 운영 루틴: 주 2회 분류와 답변 템플릿',
              '2026-05-11', 'S', end='2026-05-15', recon='2026-09-14'),
            T('(retired: duplicate of 3.2.3)', '(폐기: 3.2.3과 중복)', retired=True),
            *metrics(rng, 2026, (4, 5, 6), 280, 120),
            *interviews(rng, 2026, (5,), 2),
            T('Onboarding A/B test: day-1 retention 41% vs 48%', '온보딩 A/B 테스트: 1일 유지율 41% 대 48%',
              '2026-07-06', 'L'),
            *metrics(rng, 2026, (7,), 610, 60),
            T('Campus ambassador pilot launched at 4 campuses with 9 ambassadors',
              '캠퍼스 앰배서더 시범 운영 시작: 4개 캠퍼스, 9명', '2026-08-03', 'S', one_day=True),
            *interviews(rng, 2026, (8,), 3),
            *metrics(rng, 2026, (9, 10), 680, 70),
            T('Premium tier pricing experiment design', '프리미엄 요금제 가격 실험 설계', '2026-10-07', 'M',
              st='in_progress', last='2026-10-09', gpt2=True),
        ]),
        ('3.3', 'Grants and funding', '지원사업·투자', 'app', [
            T('Early-stage startup grant application submitted', '초기 창업 지원사업 신청서 제출', '2026-03-16', 'M',
              end='2026-03-20', due='2026-03-27', key='grantapp',
              ev=['claude', ('drive', 'Grant application', '지원사업 신청서')]),
            T('Selected for the early-stage startup grant', '초기 창업 지원사업 선정', '2026-04-24', 'S', one_day=True,
              kr=True, deps=['grantapp'], ev=['gmail']),
            T('Grant interim report submitted', '지원사업 중간 보고서 제출', '2026-08-17', 'M', due='2026-08-31'),
            T('Grant final report, draft at 60%', '지원사업 최종 보고서 (초안 60%)', '2026-10-12', 'M', st='in_progress',
              last='2026-10-15', due='2026-12-10'),
            T('Angel investor conversations', '엔젤 투자자 미팅', '2026-06-08', 'S', st='backlog', last='2026-07-01',
              gpt=True, blk=('on_hold', 'until the PhD decisions', '박사 지원 결과 이후')),
        ]),
        ('4.1', 'Teaching assistant', '조교', '', [
            *labs(rng, 2026, DS, ((2, 3),)),
            *grading(rng, 2026, DS, (3, 4, 5), 1),
            *labs(rng, 2026, DS, ((5, 4),)),
            *labs(rng, 2026, ML, ((3, 9),)),
            *grading(rng, 2026, ML, (9, 10), 1),
            *labs(rng, 2026, ML, ((7, 10),)),
            T('Machine Learning: assignment 3 grading, 31 of 58 graded', '기계학습 과제 3 채점: 58건 중 31건 완료',
              '2026-11-03', 'M', st='in_progress', last='2026-11-05', due='2026-11-10', goal=''),
            T('Machine Learning: week-10 lab session run for 33 students', '기계학습 10주차 실습 진행: 학생 33명',
              '2026-11-04', 'S', one_day=True, goal='', ev=['cal']),
        ]),
        ('4.2', 'Talks and networking', '발표·네트워킹', '', [
            T('Invited talk at the undergraduate AI club, 40 attendees', '학부 AI 동아리 초청 강연 (참석 40명)',
              '2026-04-22', 'S', one_day=True, ev=['claude', 'cal']),
            T('Summer school on trustworthy ML attended, 5 days', '신뢰할 수 있는 ML 여름학교 참가 (5일)', '2026-07-13',
              'M', end='2026-07-17', deps=['travel'], ev=['cal']),
            T('Poster on the thesis work presented at the summer school', '여름학교에서 학위 연구 포스터 발표',
              '2026-07-15', 'S', one_day=True, goal='pub'),
            T('Panel on student entrepreneurship', '학생 창업 패널 토론', '2026-10-21', 'S', one_day=True, ev=['cal']),
        ]),
        ('4.3', 'Internship', '인턴십', '', [
            T('Summer research internship application submitted', '여름 연구 인턴십 지원서 제출', '2026-02-09', 'S'),
            T('Internship interviews, 2 rounds', '인턴십 면접 2회', '2026-02-23', 'M', end='2026-03-02', ev=['cal']),
            T('Internship offer accepted for June to August', '인턴십 합격 및 수락 (6~8월)', '2026-03-20', 'S',
              one_day=True, ev=['gmail']),
            T('Internship project: anomaly alerts for a fleet dashboard', '인턴 프로젝트: 차량 관제 대시보드 이상 알림',
              size='XL', steps=[
                  T('Scope and data access agreed', '범위와 데이터 접근 합의', '2026-06-03', 'S', one_day=True),
                  T('Alert prototype on 2 weeks of fleet data', '차량 데이터 2주 분량으로 알림 시제품', '2026-06-15', 'L',
                    end='2026-06-29'),
                  T('Evaluation: precision 0.81 at 5 alerts per day', '평가: 하루 알림 5건 기준 정밀도 0.81',
                    '2026-07-20', 'M', end='2026-07-27'),
                  T('Handover: code, runbook and 3 dashboards', '인수인계: 코드, 운영 문서, 대시보드 3개', '2026-08-17',
                    'M', end='2026-08-21')]),
            T('Internship final presentation', '인턴십 최종 발표', '2026-08-24', 'S', one_day=True, ev=['claude', 'cal']),
        ]),
        ('5.1', 'Enrollment and paperwork', '학적·서류', 'admin', [
            T('Spring semester registration: thesis credits', '1학기 등록: 논문 학점', '2026-02-16', 'S'),
            T('Fall semester registration: final semester', '2학기 등록: 마지막 학기', '2026-08-17', 'S'),
            T('Graduation application filed', '졸업 신청서 제출', '2026-09-21', 'S', one_day=True, due='2026-09-30',
              imp='high'),
            T('Degree audit: all credits confirmed', '졸업 학점 확인: 전 과목 충족', '2026-10-05', 'S', one_day=True),
        ]),
        ('5.2', 'Tools and subscriptions', '장비·구독', 'admin', [
            *subscriptions(rng, 2026, (2,), 3),
            T('Laptop battery replaced', '노트북 배터리 교체', '2026-06-22', 'S', one_day=True),
            *subscriptions(rng, 2026, (7, 10), 4),
        ]),
        ('5.3', 'Tax and bookkeeping', '세무·회계', 'admin', [
            T('Q4 2025 bookkeeping: 23 receipts filed, ledger reconciled', '2025년 4분기 장부 정리: 증빙 23건, 장부 대사',
              '2026-01-12', 'S'),
            bookkeeping(rng, 2026, 1, 4),
            T('Annual income tax return filed for the business', '사업 소득 종합소득세 신고', '2026-05-18', 'M',
              end='2026-05-21', due='2026-05-31', imp='high',
              ev=['claude', ('drive', 'Tax return 2025', '2025 종합소득세 신고서')]),
            bookkeeping(rng, 2026, 2, 7),
            T('Half-year sales tax return filed', '상반기 부가가치세 신고', '2026-07-13', 'S', one_day=True, due='2026-07-25'),
            T('Q3 bookkeeping: receipts collected, ledger not reconciled yet', '3분기 장부 정리: 증빙 수집, 장부 대사 전',
              '2026-10-07', 'S', st='in_progress', last='2026-10-12', due='2026-10-31'),
        ]),
    ]
    return {2025: y25, 2026: y26}


# ------------------------------------------------------------------ build rows
DUR = {'S': (0, 1), 'M': (2, 6), 'L': (9, 24), 'XL': (35, 80)}


def hexid(rng, n=8):
    return f'{rng.getrandbits(4 * n):0{n}x}'


def build(seed):
    rng = random.Random(seed)
    data = spec(rng)
    rows, keymap = [], {}

    def make(year, pcode, pname, area, goal, sp, code, level, parent):
        st = sp.get('st', 'done')
        start = '' if sp.get('planned') or sp.get('undated') else sp['start']
        end = sp.get('end') or ''
        if st == 'done' and start and not end:
            if sp.get('one_day'):
                end = start
            else:
                lo, hi = DUR[sp['size']]
                d = rng.choice((0, 0, 1)) if sp['size'] == 'S' else rng.randint(lo, hi)
                end = min(S.to_day(start) + dt.timedelta(days=d), AS_OF - dt.timedelta(days=1)).isoformat()
        last = sp.get('last') or (end if st == 'done' else start)
        if st == 'done' and not start:
            last = ''
        ev = []   # (en, ko) pairs; only drive titles differ by language
        for e in sp.get('ev', ['claude']):
            if isinstance(e, tuple):
                ev.append((f'drive:{e[1]}', f'drive:{e[2]}'))
            elif e == 'claude':
                ev.append((f'claude:{hexid(rng)}',) * 2)
            elif e == 'gmail':
                ev.append((f'gmail:{hexid(rng, 12)}',) * 2)
            elif e == 'cal':
                ev.append((f'cal:{start}',) * 2)
            elif e.startswith('commit:'):
                ev.append((f'gh:example/{e[7:]}@{hexid(rng, 7)}',) * 2)
            else:
                ev.append((e, e))
        source = 'Claude'
        if sp.get('gpt'):
            ev.append((f'gpt:{hexid(rng)}',) * 2)
            source = 'GPT'
        if sp.get('gpt2'):
            ev.append((f'gpt:{hexid(rng)}',) * 2)
            source = 'Claude·GPT'
        word = ('not_recorded' if sp.get('undated') else 'planned') if not start else ''
        row = dict(year=str(year), code=code, level=str(level), area=area, package=pname, parent=parent,
                   task=(sp['en'], sp['ko']), start=start, end=end, st=st, kr='Y' if sp.get('kr') else '',
                   source=source, due=sp.get('due', ''), imp=sp.get('imp', ''), size=sp['size'],
                   deps=sp.get('deps', []), blk=sp.get('blk'), last=last,
                   goal=sp.get('goal', goal), ev=ev, word=word, sp=sp)
        if sp.get('key'):
            keymap[sp['key']] = (str(year), code)
        return row

    for year in sorted(data):
        for pcode, pen, pko, goal, tasks in data[year]:
            a = pcode.split('.')[0]
            area = (f'{a} {AREAS[a][0]}', f'{a} {AREAS[a][1]}')
            pname = (f'{pcode} {pen}', f'{pcode} {pko}')
            for n, sp in enumerate(tasks, start=1):
                if sp.get('retired'):
                    continue
                code = f'{pcode}.{n}'
                if not sp.get('steps'):
                    rows.append(make(year, pcode, pname, area, goal, sp, code, 3, ('', '')))
                    continue
                kids = [make(year, pcode, pname, area, goal, k, f'{code}.{i}', 4,
                             (f'{code} {sp["en"]}', f'{code} {sp["ko"]}'))
                        for i, k in enumerate(sp['steps'], start=1)]
                sts = [k['st'] for k in kids]
                if all(s == 'done' for s in sts):
                    st = 'done'
                elif all(s in ('waiting', 'done', 'backlog') for s in sts) and 'waiting' in sts \
                        and 'in_progress' not in sts:
                    st = 'waiting'
                else:
                    st = 'in_progress'
                sp2 = dict(sp, st=st, start=min(k['start'] for k in kids if k['start']),
                           end=max(k['end'] for k in kids) if st == 'done' else '',
                           last=max(k['last'] for k in kids if k['last']))
                par = make(year, pcode, pname, area, goal, sp2, code, 3, ('', ''))
                if st == 'waiting':
                    w = [k for k in kids if k['st'] == 'waiting'][-1]
                    par['blk'] = w['blk']
                rows.append(par)
                rows.extend(kids)

    # resolve dependencies and blocker placeholders now that every code is known
    for r in rows:
        deps = []
        for k in r['deps']:
            y, c = keymap[k]
            deps.append(c if y == r['year'] else f'{y}:{c}')
        r['deps_text'] = ';'.join(deps)
        r['first_dep'] = deps[0] if deps else ''
    rows.sort(key=lambda r: S.ledger_sort_key({'year': r['year'], 'code': r['code']}))
    return rows, rng


def to_record(r, lang):
    i = 0 if lang == 'en' else 1
    blk = ''
    if r['blk']:
        cat, en, ko = r['blk']
        blk = f"{S.label('blocker', cat, lang)}: {(en, ko)[i].format(dep=r['first_dep'])}"
    open_ended = r['st'] != 'done'
    date_text = S.DATE_WORDS[r['word']][i] if r['word'] else S.date_range_text(r['start'], r['end'], lang, open_ended)
    return {
        'year': r['year'], 'code': r['code'], 'level': r['level'], 'area': r['area'][i],
        'package': r['package'][i], 'parent': r['parent'][i], 'task': r['task'][i],
        'start': r['start'], 'end': r['end'], 'date_text': date_text, 'start_month': r['start'][:7],
        'status': S.label('status', r['st'], lang), 'key_result': r['kr'], 'source': r['source'],
        'due': r['due'], 'importance': S.label('importance', r['imp'], lang), 'size': r['size'],
        'depends_on': r['deps_text'], 'blocker': blk, 'last_progress': r['last'],
        'goal': GOALS[r['goal']][i] if r['goal'] else '', 'evidence': ';'.join(e[i] for e in r['ev']),
    }


# ------------------------------------------------------------------ events
MEMO = {
    'enrich': ('progress recorded', '진행 기록'),
    'recon': ('onboarding reconciliation', '온보딩 상태 확인'),
    'undated': ('logged without a date, flagged for the sweep', '날짜 없이 기록, 수집 때 확인'),
}


def events(rows, lang):
    i = 0 if lang == 'en' else 1
    st = lambda c: S.label('status', c, lang)
    out = []

    def add(date, r, kind, a, b, memo=''):
        out.append({'date': date, 'year': r['year'], 'code': r['code'], 'event': S.label('event', kind, lang),
                    'from_status': st(a), 'to_status': st(b), 'memo': memo,
                    'source': 'GPT' if r['source'] == 'GPT' else 'Claude',
                    'estimated': 'Y' if S.to_day(date) < BOOTSTRAP else ''})
    for r in rows:
        sp = r['sp']
        blk = to_record(r, lang)['blocker']
        if not r['start']:
            first = sp.get('logged') or BOOTSTRAP.isoformat()
            add(first, r, 'create', '', r['st'], MEMO['undated'][i] if sp.get('undated') else blk)
            continue
        created_as = 'waiting' if r['st'] == 'waiting' and r['start'] == r['last'] else 'in_progress'
        add(r['start'], r, 'create', '', created_as)
        if sp.get('recon'):
            add(sp['recon'], r, 'status', 'in_progress', 'done', MEMO['recon'][i])
        elif r['st'] == 'done':
            add(r['end'], r, 'status', 'in_progress', 'done')
        elif r['st'] == 'backlog':
            add(r['last'], r, 'status', 'in_progress', 'backlog', blk)
        elif r['st'] == 'waiting' and created_as != 'waiting':
            add(r['last'], r, 'status', 'in_progress', 'waiting', blk)
        elif r['st'] == 'in_progress' and r['last'] > r['start']:
            add(r['last'], r, 'enrich', 'in_progress', 'in_progress', MEMO['enrich'][i])
        if sp.get('move'):
            d, en, ko = sp['move']
            add(d, r, 'move', '', '', (en, ko)[i])
        if sp.get('correct'):
            d, en, ko = sp['correct']
            add(d, r, 'correct', '', '', (en, ko)[i])
    out.sort(key=lambda e: (e['date'], -int(e['year']), S.code_key(e['code'])))
    return out


# ------------------------------------------------------------------ coverage and plan
SOURCES = [('claude', 'Claude chats', 'Claude 대화'), ('chatgpt', 'ChatGPT export', 'ChatGPT 내보내기'),
           ('github', 'GitHub', 'GitHub'), ('drive', 'Google Drive', 'Google Drive'),
           ('calendar', 'Google Calendar', 'Google Calendar'), ('slack', 'Slack', 'Slack')]


def coverage(rng):
    """Window states by source and month (lang-neutral), memo text in both languages."""
    out = []
    months = [(2025, m) for m in range(1, 13)] + [(2026, m) for m in range(1, 12)]
    for y, m in months:
        ym = f'{y}-{m:02d}'
        for key, en, ko in SOURCES:
            n = rng.randint(8, 60)
            checked = (BOOTSTRAP + dt.timedelta(days=rng.randint(0, 36))).isoformat()
            done = ('complete', str(rng.choice((2, 2, 3))), '0', checked)
            if key == 'claude':
                if ym <= '2026-09':
                    st, memo = done, (f'{n} chats listed by ID and judged, 0 new', f'대화 {n}개 ID 전수 판정, 신규 0')
                elif ym == '2026-10':
                    st, memo = ('partial', '2', '1', '2026-11-05'), (f'{n} chats listed by ID, 1 new', f'대화 {n}개 ID 전수, 신규 1')
                else:
                    st, memo = ('partial', '1', '0', '2026-11-05'), ('month still running', '진행 중인 달')
            elif key == 'chatgpt':
                if ym <= '2026-08':
                    st, memo = done, (f'export of 2026-09-10: {n} conversations, 0 new', f'2026-09-10 내보내기: 대화 {n}개, 신규 0')
                elif ym == '2026-09':
                    st, memo = ('partial', '1', '0', '2026-09-14'), ('tool limit: the export ends on 2026-09-10',
                                                                     '도구 한계: 내보내기가 2026-09-10까지')
                else:
                    st, memo = ('not_started', '0', '', ''), ('needs a new export from the user', '새 내보내기 파일 필요')
            elif key == 'github':
                if ym <= '2026-09':
                    st, memo = done, (f'{n} commits on all branches, 0 new', f'전 브랜치 커밋 {n}개, 신규 0')
                else:
                    st, memo = ('partial', '1', str(rng.randint(0, 2)), '2026-11-05'), (f'{n} commits on all branches', f'전 브랜치 커밋 {n}개')
            elif key == 'drive':
                if ym <= '2026-08':
                    st, memo = done, (f'{n} files by created and modified time, 0 new', f'생성·수정 시각 기준 파일 {n}개, 신규 0')
                elif ym <= '2026-10':
                    st, memo = ('partial', '1', '1', '2026-10-20'), (f'{n} files by modified time only', f'수정 시각 기준 파일 {n}개만')
                else:
                    st, memo = ('not_started', '0', '', ''), ('', '')
            elif key == 'calendar':
                if ym <= '2026-10':
                    st, memo = done, (f'{n} events, 0 new', f'일정 {n}개, 신규 0')
                else:
                    st, memo = ('partial', '1', '0', '2026-11-05'), ('month still running', '진행 중인 달')
            else:  # slack: the free plan keeps about 90 days
                if ym < '2026-06':
                    st, memo = ('unavailable', '0', '', ''), ('older than the ~90 days kept on the free plan',
                                                             '무료 요금제 보존 기간(약 90일) 이전')
                elif ym == '2026-06':
                    st, memo = ('partial', '1', '0', '2026-09-14'), ('tool limit: visible from 06-16 only', '도구 한계: 06-16부터만 보임')
                elif ym <= '2026-09':
                    st, memo = done, (f'{n} own messages, 0 new', f'내 메시지 {n}개, 신규 0')
                elif ym == '2026-10':
                    st, memo = ('partial', '1', '0', '2026-11-05'), (f'{n} own messages', f'내 메시지 {n}개')
                else:
                    st, memo = ('not_started', '0', '', ''), ('', '')
            out.append((str(y), f'{m:02d}', (en, ko), st, memo))
    return out


def coverage_records(cov, lang):
    i = 0 if lang == 'en' else 1
    recs = []
    for y, m, src, (state, passes, new, checked), memo in sorted(cov, key=lambda c: (-int(c[0]), c[1], SOURCES_ORDER[c[2][0]])):
        recs.append({'year': y, 'month': m, 'source': src[i], 'state': S.label('coverage_state', state, lang),
                     'passes': passes, 'new_last_pass': new, 'last_checked': checked, 'memo': memo[i]})
    return recs


SOURCES_ORDER = {en: n for n, (_, en, _) in enumerate(SOURCES)}


def plan_records(lang):
    i = 0 if lang == 'en' else 1
    kind = lambda k: S.label('plan_kind', k, lang)
    recs = [{'kind': kind('goal'), 'year': '', 'target': g[i], 'note': g[2 + i], 'decided': BOOTSTRAP.isoformat(),
             'recheck': ''} for g in GOALS.values()]
    recs += [
        {'kind': kind('focus'), 'year': '2026', 'target': '1.1',
         'note': ('Final thesis and repository submission by the end of November', '11월 말까지 학위논문 최종본과 저장소 제출')[i],
         'decided': '2026-11-02', 'recheck': '2026-11-30'},
        {'kind': kind('focus'), 'year': '2026', 'target': '2.1',
         'note': ('PhD applications: University B by Dec 1, University C by Dec 15', '박사 지원: B대학 12월 1일, C대학 12월 15일')[i],
         'decided': '2026-11-02', 'recheck': '2026-11-30'},
        {'kind': kind('checkup'), 'year': '2026', 'target': '',
         'note': ('Weekly health check, first one after the bootstrap', '주간 검진, 부트스트랩 후 첫 검진')[i],
         'decided': '2026-11-02', 'recheck': '2026-11-09'},
        {'kind': kind('config'), 'year': '', 'target': 'publish', 'note': 'folder:.', 'decided': BOOTSTRAP.isoformat(),
         'recheck': ''},
    ]
    return recs


# ------------------------------------------------------------------ main
def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description='Generate the synthetic sample ledger (English and Korean).')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(here), 'sample'), help='output folder')
    ap.add_argument('--seed', type=int, default=7, help='random seed (default 7)')
    args = ap.parse_args()
    rows, rng = build(args.seed)
    cov = coverage(rng)
    for lang in LANGS:
        folder = os.path.join(args.out, lang)
        os.makedirs(folder, exist_ok=True)
        S.write_table(os.path.join(folder, 'wbs.csv'), 'wbs', [to_record(r, lang) for r in rows], lang)
        S.write_table(os.path.join(folder, 'events.csv'), 'events', events(rows, lang), lang)
        S.write_table(os.path.join(folder, 'coverage.csv'), 'coverage', coverage_records(cov, lang), lang)
        S.write_table(os.path.join(folder, 'plan.csv'), 'plan', plan_records(lang), lang)
    leaves = S.leaf_rows([{'year': r['year'], 'code': r['code'], 'level': r['level']} for r in rows])
    print(f'{args.out}: {len(rows)} rows ({len(leaves)} leaves) in en and ko, seed {args.seed}')


if __name__ == '__main__':
    main()
