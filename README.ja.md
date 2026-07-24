<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

<p align="center">
  <img src=".github/assets/banner.png" alt="Ailin¹ Collective Intelligence: thousands of AI models coordinate inside one collective model" width="100%">
</p>

# Ailin¹ Collective Intelligence

> 🌐 正式版(canonical)は英語版です。この翻訳はコミット 596a94e6 に対応しています。迷った場合は英語版 README([README.md](README.md))をお読みください。

<p align="center">
  <a href="README.md"><img alt="English" src="https://img.shields.io/badge/English-30363d?style=for-the-badge"></a>
  <a href="README.zh-CN.md"><img alt="简体中文" src="https://img.shields.io/badge/%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-30363d?style=for-the-badge"></a>
  <a href="README.pt-BR.md"><img alt="Português (BR)" src="https://img.shields.io/badge/Portugu%C3%AAs%20(BR)-30363d?style=for-the-badge"></a>
  <a href="README.es.md"><img alt="Español" src="https://img.shields.io/badge/Espa%C3%B1ol-30363d?style=for-the-badge"></a>
  <a href="README.ja.md"><img alt="日本語" src="https://img.shields.io/badge/%E6%97%A5%E6%9C%AC%E8%AA%9E-1f6feb?style=for-the-badge"></a>
  <a href="README.ko.md"><img alt="한국어" src="https://img.shields.io/badge/%ED%95%9C%EA%B5%AD%EC%96%B4-30363d?style=for-the-badge"></a>
  <a href="README.fr.md"><img alt="Français" src="https://img.shields.io/badge/Fran%C3%A7ais-30363d?style=for-the-badge"></a>
  <a href="README.de.md"><img alt="Deutsch" src="https://img.shields.io/badge/Deutsch-30363d?style=for-the-badge"></a>
  <a href="README.ru.md"><img alt="Русский" src="https://img.shields.io/badge/%D0%A0%D1%83%D1%81%D1%81%D0%BA%D0%B8%D0%B9-30363d?style=for-the-badge"></a>
</p>

> **TL;DR**: Ailin¹ は **76,636 個の AI モデル** をひとつのコレクティブ・モデルの中で協調させ、単一モデルへのルーティングではなく **32 の戦略** でオーケストレーションします。すべてのリクエストに構造化された多様性・独立した推論・完全な意思決定の監査証跡を付与し、単一モデル統合よりも信頼性・耐障害性・監査可能性に優れます。さらに[公開の場でフロンティアを相手に実証済み](#フロンティアを相手に公開の場で実証済み)。
>
> **→ [クイックスタート](#クイックスタート) · [エビデンスを見る](#フロンティアを相手に公開の場で実証済み) · [ドキュメント](https://ailin.guide)**

<p align="center">
  <a href="https://github.com/ailinone/collective-intelligence"><b>⭐ リポジトリに Star を付けて、より集合的で協調的な AI の新しい時代を後押ししてください。モデルが単独ではなく、共に勝つ時代です。</b></a>
</p>

**数千のAIモデルが、ひとつのコレクティブ・モデルの中で協調する。**

構造化された多様性、独立した推論、そしてすべてのリクエストに付随する
完全な意思決定プロビナンス: 単一モデル統合よりも信頼性が高く、
耐障害性に優れ、監査可能なアウトプットを生み出すために設計されています。
毎日のように「最強」を掲げる新モデルが登場します。ここは、それらが
共に働くレイヤーです。完全なドキュメント: **[ailin.guide](https://ailin.guide)**。

[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](LICENSE)
[![CI](https://github.com/ailinone/collective-intelligence/actions/workflows/ci.yml/badge.svg)](https://github.com/ailinone/collective-intelligence/actions/workflows/ci.yml)
[![REUSE compliance](https://github.com/ailinone/collective-intelligence/actions/workflows/license-compliance.yml/badge.svg)](https://github.com/ailinone/collective-intelligence/actions/workflows/license-compliance.yml)
[![DCO](https://img.shields.io/badge/DCO-required-brightgreen)](DCO.md)
[![Providers](https://img.shields.io/badge/provider_integrations-~90-8A2BE2)](https://ailin.guide/architecture/provider-ecosystem)
[![Models indexed](https://img.shields.io/badge/models_indexed-76%2C636-blueviolet)](#数万のモデル常にフロンティアに)
[![Strategies](https://img.shields.io/badge/collective_strategies-32_registered-6A5ACD)](#リクエストの流れ)
[![GitHub stars](https://img.shields.io/github/stars/ailinone/collective-intelligence?style=social)](https://github.com/ailinone/collective-intelligence/stargazers)
[![Discussions](https://img.shields.io/badge/discussions-open-2ea44f?logo=github)](https://github.com/ailinone/collective-intelligence/discussions)

[クイックスタート](#クイックスタート) · [次なるフロンティア](#コレクティブインテリジェンスaiの次なるフロンティア) ·
[なぜコレクティブか](#なぜコレクティブは最大の単一モデルに勝るのか) ·
[エビデンス](#フロンティアを相手に公開の場で実証済み) ·
[常にフロンティアに](#数万のモデル常にフロンティアに) ·
[仕組み](#アーキテクチャ概観) ·
[コントリビューション](#コントリビューションコレクティブインテリジェンスにはコレクティブが必要だ) · [ドキュメント](https://ailin.guide)

---

## コレクティブ・インテリジェンス：AIの次なるフロンティア

AI業界は、より大きな単一モデルを構築することに注力してきました。
Ailin¹ はそれを補完するアプローチを取ります: **76,636のAIモデル**
(2026-07時点の本番稼働数)からなるコレクティブが、協調し、討論し、
批評し、統合する。単一モデルがトレーニング・アーキテクチャ・バイアス・
障害それぞれの単一点となってしまう問題に対して、
[構造化された多様性](https://ailin.guide/architecture/cognitive-diversity)を適用します。

**これはマルチモデル・ルーティングではありません。APIゲートウェイでも
ありません。これはコレクティブ・インテリジェンスです**: フロンティア
API、オープンウェイトの挑戦者、そして自社モデルファミリーという、
あらゆる主要アーキテクチャのモデルが
[数十の戦略](https://ailin.guide/architecture/strategy-catalog)を通じて協調するシステム。
目指すのは、いかなる単一モデル統合よりも高い信頼性、広い評価カバレッジ、
そして完全な監査可能性です。

この原理は、コレクティブ・インテリジェンスと認知的多様性に関する研究に
根ざしています: Hong & Page の「diversity trumps ability(多様性は
能力に勝る)」という結果や、Woolley らによる集合的パフォーマンスの
研究(公開の[参考文献一覧](https://ailin.guide/reference/bibliography)を参照)。
Ailin¹ はその原理をエンジニアリング・プラットフォームとして実装します:
76,636のモデルをインデックスするディスカバリーエンジン、数十の協調戦略、
すべての協調上の意思決定を記録する
[監査基盤](https://ailin.guide/architecture/collective-intelligence)、
そしてクローズドループの学習パイプライン。これらのレイヤーには今日
すでに本番品質のものもあれば、まだ成熟途上のものもあります。
ドキュメントにはステータスバッジが付いており、何が提供済みで何が
ロードマップ上にあるのか、常に分かるようになっています。

## なぜコレクティブは最大の単一モデルに勝るのか

フロンティアモデルは大型化を続けており、その時々の最強単一モデルは
見事なものです。しかし単一モデルは常に、トレーニングの単一点、
アーキテクチャの単一点、障害の単一点、そしてバイアスの単一点です。
よく協調されたコレクティブは、スケールだけでは決して届かない形で、
これらの構造的限界の一つひとつに対処します。

- **レジリエンス。** 単一モデルは単一の依存を意味します。その
  プロバイダーがある日、性能劣化・スロットリング・レート制限・誤った
  価格設定に見舞われれば、すべての呼び出しが影響を受けます。
  コレクティブは、プロバイダー障害・劣化したモデル・局所的な失敗を
  人手の介入なしに迂回します。リクエストは完全なプロビナンス付きで
  成功し続けます
  ([レジリエンス詳説](https://ailin.guide/architecture/why-collective-resilience))。
- **評価の多様性。** モデルはそれぞれ異なるデータで、異なる目的の
  もとに訓練されています。多数のモデルに問い、出力を比較することで、
  どれほど巨大な単一モデルでも自信満々に繰り返してしまう誤りや盲点が
  あぶり出されます。コレクティブは、意見の不一致をバグではなく品質の
  シグナルへと変えます。
- **集中の回避。** ひとつのモデルへの依存は、組織をひとつのベンダーの
  ロードマップ・価格・ポリシー判断に縛り付けます。コレクティブは能力を
  特定のプロバイダーから切り離します。フロンティアが移り変わり、
  個々のプロバイダーが台頭し、衰退し、価格を改定しても、
  プラットフォームは動き続けます。
- **単一点バイアスの低減。** どのモデルも、訓練データ由来のバイアス、
  拒否パターン、文体上のデフォルトを抱えています。アーキテクチャの
  異なるモデルからなるコレクティブは、特定のモデルの盲点が及ぼす
  影響を拡散させます。独立した推論者たちの間での収束を要求する
  裁定戦略においては、とりわけ顕著です。
- **動的スペシャライゼーション。** すべてにおいて最良の単一モデルは
  存在しません。コレクティブは、適切なスペシャリストを適切なタスクに
  割り当てられます(推論重視、コード重視、ビジョン、ロング
  コンテキスト、低レイテンシ)。そして各リクエストを、そのタスクが
  強さを要求するまさにその点で強いモデルへとルーティングします。
- **より強固なガバナンス。** エンタープライズのワークロードには、
  監査可能な意思決定、上限付きコスト、テナント分離、信頼できる
  フォールバックが必要です。単一モデル統合では、それらの統制の構築は
  インテグレーター任せになります。コレクティブはガバナンスを
  プラットフォーム層で強制します: 意思決定プロビナンス、コスト上限、
  クォータ分離、ポリシー強制が、すべてのリクエスト、すべての戦略、
  すべてのモデルに適用されます。

この効果は複利で効いてきます。これらは6つの独立した機能ではありません。
多数のモデルをうまく協調させるという、ひとつの構造的選択が持つ
6つの側面です。その結果は、より信頼でき、よりガバナンスが効き、より
持続的で、そして、正しさを客観的に検証できるタスクの拡大し続ける
領域においては、**私たちがテストしたすべてのフロンティア・
フラッグシップよりも測定可能なかたちで高精度**です
(97% vs 68–82%、証拠は下記)。

## フロンティアを相手に、公開の場で実証済み

私たちはこのテーゼを、自らを相手に、公開の場で、客観的な採点によって
検証しています: 固定されたジャッジ、タスクが許す限りの機械検証可能な
解答、そして実行単位の生データはこのリポジトリにコミット済みです
(**[完全レポート](reports/experiments/AILIN-COLLECTIVE-FRONTIER-BENCHMARK-2026-07.md)** ·
[生CSV + スクリプト](reports/experiments/) ·
[すべてのテーブルを自分で再生成](docs/experiments/REPRODUCING_THE_BENCHMARK.md))。

**✅ 検証済み: 検証可能なタスクにおいて、コレクティブはすべての
フロンティア・フラッグシップに勝利。** 決定論的な解答検証器を備えた
コンセンサスは **97%の客観的正答率(37/38)** を記録しました。対する
GPT-5.5-pro、Claude Opus 4.8、Gemini 3.1 Pro、Grok 4.3 は、全3ランを
プールして **68–82%**。しかも全ランを通じて、**検証器が客観的に
誤った解答を選んだことは一度もありません**。フロンティア未満の
オープンウェイトモデルのプールが、うまく協調することで、同一タスクに
おいてすべてのフラッグシップを上回る解答を出したのです
([すべての n と注意点を記載したリーダーボード、§3](reports/experiments/AILIN-COLLECTIVE-FRONTIER-BENCHMARK-2026-07.md))。

**このテーゼの現在のフロンティア**、誠実に測定し、ロードマップを
駆動しています:

| 軸 | 現在 | 私たちの対応 |
|---|---|---|
| 検証可能な正しさ | ✅ **コレクティブの勝利**(97% vs 68–82%) | 検証器のカバレッジをより多くのタスク形状へ拡大中(ツールコーリング・キャンペーンは 2026-07-18 に完了) |
| 自由記述の文章 | クリエイティブライティングとリファクタリングでは依然として単一モデルが勝つ | ディサイダーの選定が勝ちランと負けランを測定可能なかたちで分ける: 学習可能なレバー([§7](reports/experiments/AILIN-COLLECTIVE-FRONTIER-BENCHMARK-2026-07.md)) |
| コスト | 記録の通りコレクティブにはプレミアムが乗る。**ただし**検証器のショートサーキットは例外で、発動時にはそれを ~100× 圧縮する([§5](reports/experiments/AILIN-COLLECTIVE-FRONTIER-BENCHMARK-2026-07.md)) | ショートサーキット経路を拡大中; `ailin-auto` は実行可能な最安戦略をデフォルトとする |
| レイテンシ | マルチラウンド裁定: すべての戦略が最初のトークンからリアルタイムに進捗をストリーミングします | `ailin-auto` は、品質ゲートが実際に必要とする場合にのみ最も踏み込んだ戦略を温存します; レイテンシ重視のトラフィックは設計上 `single` にルーティングされます |

上記のすべての数値は、このリポジトリにコミットされた実行単位の生データと
再現可能なスクリプトに裏付けられています。ハーネスを自分自身の
ワークロードで実行し、私たちに同じ基準を突きつけてください。

## 数万のモデル、常にフロンティアに

Ailin¹ のコレクティブは、ハードコードされたモデルリストや手作業の
プロバイダー統合に依存しません。継続的なディスカバリーエンジンが
グローバルなAIエコシステムをスキャンし、新しいモデルがリリースされると
自動的に吸収します。

その結果: [~90のプロバイダー統合](https://ailin.guide/architecture/provider-ecosystem)にまたがる
**76,636モデル**のライブなコレクティブが、エコシステムの最新状態を
保ち続けます。発見済みのソースから新しいモデルが公開されると、
ディスカバリーエンジンはコード変更・設定・ダウンタイムなしにそれを
吸収します。

### セマンティック・ディスカバリー、ハードコードされたモデルはゼロ

ディスカバリーエンジンは数十のソースを並列にスキャンします:
ネイティブのプロバイダーAPI、クラウドハブ、モデルアグリゲーター、
オープンモデルのリポジトリ、プライベート推論エンドポイント。しかし
ソースそのものは本質ではありません。重要なのは、モデルがどのように
選ばれるかです。

発見されたすべてのモデルは、能力、パフォーマンスプロファイル、価格、
コンテキストウィンドウ、モダリティ、アーキテクチャによって分析・分類・
インデックスされます。手作業のマッピングや設定なしに、自動的に
推定されます。ルートはヘルスゲート付きです: モデルは、実際に稼働
していることが証明されてはじめて広告されます。

モデル選定は**完全にセマンティック**です。リクエストが到着したとき、
コレクティブは静的なリストから選ぶのではありません。タスクの要件、
選ばれた戦略、望ましいアウトカムプロファイル(最高品質、最良のコスト
対効果、最低コスト、最速応答)に基づいて、理想のモデルチームを
編成します。適切なモデルが、一つひとつのリクエストごとに、リアル
タイムで選出されるのです。明日「史上最強のモデル」が登場したとき、
コレクティブはそれと競争するのではなく、それを吸収します。

### 自社モデルも同じアリーナで

`ailin` モデルファミリーとその学習フライホイールは設計の一部です:
エンジン自身の協調トラフィックで訓練されたコーディネーター・
チェックポイントが、すべてのサードパーティモデルと同じプールで
競います。ルーティング上の特権は一切なし。すべての協調上の意思決定を
捕捉する監査基盤は今日すでに提供されています; 本番のコーディネーター・
ウェイトが開発中の最先端です
([誠実なステータス、常に最新](https://ailin.guide))。

### 反証可能な仮説としてのコレクティブ戦略

登録済みの32戦略(収束フロア付きコンセンサス、ブラインド討論、
エキスパートパネル、悪魔の代弁者コンセンサス、コストカスケード、
客観的検証付き best-of-N)、それぞれに誠実な到達可能性ラベル
(自動選択可 / 明示指定のみ / ロードマップ)が付き、それぞれがこの
リポジトリの実験ハーネスで反証可能です。戦略はエビデンスによって
その地位を勝ち取り、あるいは失います。

### マルチモーダル + 決定論的ファイル生成

マルチモーダル生成(画像・音声・動画)は能力ベースでルーティング
され、加えて、構造化出力に対応した任意のチャットモデルからの
決定論的なファイルレンダリング(DOCX、XLSX、PDF、PPTX、ZIP、コード)。
本番環境で実証済みです。

### エンタープライズが本当に必要とするガバナンス

完全な意思決定プロビナンス(`ailin_metadata`: 戦略、モデル、最終
ディサイダー、サブコール単位のコスト、異論)、アドミッション時に
強制されるリクエスト単位の `max_cost`、アーキテクチャレベルのテナント
分離、エンジン自身が提供する AGPL §13 エンドポイント(`/source`、
`/license`)、SPDX SBOM を伴う SLSA/Sigstore リリースプロビナンス。
私たちの主張を証明する監査証跡は、あなたのトラフィックを統治するのと
同じものです。ガバナンスはオーバーヘッドではなく
[第一級の原則](https://ailin.guide/architecture/principles)です。

## アーキテクチャ概観

エンドツーエンドのシステム全体、ディスカバリーがチーム編成に情報を
供給し、あらゆる実行パスが同じプロビナンス生成裁定ステップへ収束し
ます:

```mermaid
flowchart TB
    SDK[Any OpenAI SDK / curl<br/>base_url swap only] --> GW[OpenAI-compatible API]
    subgraph Engine[Ailin¹ Collective Intelligence]
        GW --> SR[Strategy resolution<br/>ailin-auto conservative cascade]
        SR --> TA[Team assembly<br/>semantic selection over the live catalog]
        TA --> EX[Execution<br/>fallback chains · budget governor]
        EX --> AR[Arbitration<br/>quality gates · deterministic verifier]
        AR --> PV[Provenance<br/>ailin_metadata on every response]
    end
    DISC[Continuous discovery engine<br/>health-gated · zero hardcoded models] --> TA
    EX <--> PROV[~90 provider integrations<br/>frontier APIs · aggregators · self-hosted]
```

## リクエストの流れ

ひとつのリクエストにズームインすると、上記の3つの経路のうちどれを
辿るか、そしてその理由は:

```mermaid
flowchart LR
    A[OpenAI-compatible request] --> B{Strategy resolution<br/>ailin-auto cascade}
    B -->|simple| C[Single model<br/>cheapest viable]
    B -->|declared answer_check| D[Consensus + verifier]
    B -->|explicit| E[1 of 32 strategies]
    C --> F[Execution + fallback chains]
    D --> F
    E --> F
    F --> G[Arbitration & quality gate]
    G --> H[Response + ailin_metadata<br/>full decision provenance]
```

検証器は、リクエストが `ailin_constraints.answer_check` で機械検証
可能な解答を宣言したときに武装します。カスケードは保守的です。経済
設計はデフォルトで安価な経路を優先し、品質ゲートが要求するときにのみ
エスカレーションします。そして協調はタダではないため、エンジン自身の
ドキュメントが
[単一モデルが正解となるのはどんな場合か](docs/use-cases/when-not-to-use-collective.md)
([ガイドにも掲載](https://ailin.guide/use-cases/when-not-to-use-collective))を
率直に教えてくれます: 大量・低リスクのトラフィック、厳しい
レイテンシSLA、ドキュメント調の文章。この判断は哲学ではなく、運用の
問題です。

## クイックスタート

> Compose v2 対応の Docker、~8 GB の空きRAM、空きポート
> 3000/5432/6379 が必要です。Windows では、以下のブロックを
> **Git Bash または WSL** で実行してください(ヒアドキュメントと
> `openssl` を使用しています)。

```bash
git clone https://github.com/ailinone/collective-intelligence.git
cd collective-intelligence/docker
cat > .env <<EOF
# strong JWT secrets are REQUIRED — the app refuses weak/default values
JWT_SECRET=$(openssl rand -base64 48)
AILIN_SHARED_JWT_SECRET=$(openssl rand -base64 48)
# local-first secrets: skip GCP Secret Manager entirely
SECRETS_PROVIDER_PRIMARY=env
# one provider key is the minimum — any of the ~90 works
OPENAI_API_KEY=sk-...
EOF
```

`.env` を編集して `sk-...` を実際のキーに置き換えてください(キーを
一切使わないことも可能です: 下記の Ollama オプションを参照)。その後:

```bash
docker compose up -d api postgres redis
docker compose logs -f api    # watch first boot: migrations + discovery, ~1-5 min
curl http://localhost:3000/health
# → {"status":"ok","uptime":…,"version":"0.1.0"}
```

(コーディネーターのサービング面である `coord-serving` が API と並んで
ビルド・起動します。これは想定どおりの挙動です。)ローカルアカウントを
作成し、コレクティブを呼び出します:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"pick-a-strong-one","name":"You"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['tokens']['accessToken'])")
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:3000/v1", api_key=TOKEN)

r = client.chat.completions.create(
    model="ailin-auto",   # or ailin-best / ailin-fast / ailin-economy / ailin-consensus
    messages=[{"role": "user", "content": "Why is the sky blue?"}],
)
print(r.choices[0].message.content)
print(r.model_extra["ailin_metadata"])  # strategy, models, costs, dissent — the receipts
```

外部APIキーが一切ない場合は、`docker/.env` に
`OLLAMA_URL=http://host.docker.internal:11434` を設定すると、エンジンは
セルフホストの縮退モードで起動します
([ドキュメント](docs/hardening/DEGRADED_BOOT_MODE.md))。ネイティブ
Linux では、api サービスに
`extra_hosts: ["host.docker.internal:host-gateway"]` も追加してください
(またはブリッジIPを使用)。完全なローカルセットアップ:
[インストールガイド](docs/getting-started/installation.md)。ホステッド
APIのクイックスタート:
[ailin.guide/getting-started/quickstart](https://ailin.guide/getting-started/quickstart)。

## 現在提供中のもの vs. 開発中のもの

| 現在提供中 | 開発中 |
|---|---|
| OpenAI互換API(chat、responses、embeddings、images、files) | 訓練済みコーディネーター・ウェイト(設計 + 監査基盤は提供済み) |
| 32のオーケストレーション戦略(単一モデルのベースラインを含む)+ `ailin-auto` カスケード | 自社モデルファミリーの本番ウェイト(学習フライホイールは構築済み) |
| ディスカバリーエンジン、ヘルスゲート付きルーティング、フォールバックチェーン | 完全に監査されたコスト会計を伴う拡大ベンチマークキャンペーン |
| 完全な意思決定プロビナンス(`ailin_metadata`) | 独立評価のためのステップバイステップのキャンペーンガイド |
| マルチモーダル + 決定論的ファイル生成(DOCX/XLSX/PDF/PPTX/ZIP/コード) | |
| AGPL §13 エンドポイント(`/source`、`/license`)+ ライセンス・レスポンスヘッダー | |
| ブロードキャスト配信パイプライン(コードは `BROADCAST_FEATURE_ENABLED` の背後で提供、デフォルトはオフ; 本番検証は未了) | |

検証に関する誠実さはひとつの機能です。左の列にないものはすべて、
ここでのラベル付けと同じ方法で、ドキュメント内でもラベル付けされて
います。

## コントリビューション：コレクティブ・インテリジェンスにはコレクティブが必要だ

テーゼそのものがこれを予言しています: 多様で独立したコントリビューター
がうまく協調すれば、単独の努力では決して作れないものを作り上げる、と。
コードのコントリビューションは **DCO** のもとで歓迎します
(`git commit -s`、[DCO.md](DCO.md) と
[CONTRIBUTING.md](CONTRIBUTING.md) を参照): プロバイダーアダプター
(薄く自己完結したモジュール)、戦略実装、客観的タスクチェッカー、
[ailin.guide](https://ailin.guide) のドキュメント。

そしてこのプロジェクトには、ほとんどのプロジェクトにはない
コントリビューション面があります: **ベンチマークを自分で走らせ、
結果を公開してください、結果がどちらに転んでも。** まずは
[REPRODUCING_THE_BENCHMARK.md](docs/experiments/REPRODUCING_THE_BENCHMARK.md)
から: コミット済みの生データから公開済みのすべてのテーブルを再生成
するのに必要なのは、約2分と Python の標準ライブラリだけです。すべての
独立した再現は(検証するものであれ反証するものであれ)コレクティブを
より賢くします。それこそが核心です。

質問と結果の報告: [GitHub Discussions](https://github.com/ailinone/collective-intelligence/discussions)。
セキュリティ報告: **決して**公開Issueにしないでください。
[SECURITY.md](SECURITY.md) を参照。

## ライセンスとガバナンス

**AGPL-3.0-or-later。** 改変したバージョンをネットワークサービスとして
運用する場合、§13 はそのユーザーに対応するソースコードを提供することを
要求します。エンジンは `/source` と `/license` エンドポイントを提供し、
すべてのレスポンスに `X-License`/`X-Source-Code` ヘッダーを送信する
ため、遵守は容易です(`AGPL_SOURCE_URL` を*あなたの*改変ソースを指す
ように設定してください)。[COMPLIANCE.md](COMPLIANCE.md) を参照;
商用ライセンス: licensing@ailin.one。

| | |
|---|---|
| コントリビューターのサインオフ(DCO 1.1) | [DCO.md](DCO.md) |
| 行動規範(Contributor Covenant 2.1) | [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) |
| 商標("Ailin"、"Ailin One"、"ailin.one") | [TRADEMARKS.md](TRADEMARKS.md) |
| リリースプロビナンス(SLSA/Sigstore + SPDX SBOM) | [release-provenance.yml](.github/workflows/release-provenance.yml) |
| セキュリティポリシー | [SECURITY.md](SECURITY.md) |
| 変更履歴(v0.1.0) | [CHANGELOG.md](CHANGELOG.md) |
| 完全なドキュメント | [ailin.guide](https://ailin.guide) |

**Ailin One, Inc.** によって保守されています。AGPL がライセンスするのは
コードであり、商標ではありません。

## スター履歴とコントリビューター

[![Star History Chart](https://api.star-history.com/svg?repos=ailinone/collective-intelligence&type=Date)](https://star-history.com/#ailinone/collective-intelligence&Date)

<a href="https://github.com/ailinone/collective-intelligence/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=ailinone/collective-intelligence" alt="Contributors" />
</a>

公開の場で検証され、証拠がリポジトリに揃った、このコレクティブ・
インテリジェンスのテーゼ。それがこの世界に存在してほしいものだと
思うなら、⭐ こそが、他の開発者に「これは10分を割く価値がある」と
伝える方法です。
</content>
