# ブラウザ差の扱い

このライブラリは、Chrome と Firefox で**同じコードが同じ結果になる**ことを目標にしています。
ブラウザ API の差は次のいずれかの方法で解消しています。

1. **内部で吸収する**: 内部でブラウザごとに異なる API を呼び分け、同じ結果を返す
2. **独自に実装する**: 片方のブラウザにない機能を、両方で同じ仕組みで実装する
3. **揃えられない機能は提供しない**: 動作を揃えられない機能は API に含めない（または両方で同じエラーにする）

ライブラリでは揃えられないものは、Manifest の書式と [ブラウザ自体の制約](#ライブラリの外にある差) だけです。

対象は desktop の Chrome 142 以降・Firefox 145 以降です。

## サイドパネル

| 機能 | Chrome | Firefox | ライブラリ |
| --- | --- | --- | --- |
| API | `sidePanel` | `sidebarAction` | `webextSidePanel` で共通化 |
| 開く・閉じる | `open/close({ windowId })` | 引数なし（操作中のウィンドウ） | 操作中のウィンドウを対象に統一。`windowId` は操作したウィンドウを指定する前提 |
| 開閉の切り替え | なし | `toggle()` | Chrome は開閉状態を調べて `open` / `close` |
| 開いているか | なし（`getContexts()` のパネルは `windowId: -1`） | `isOpen()` | Chrome はパネル側（`registerPanel()`）と Background（`startBackground()`）が状態を答える |
| 開閉イベント | `onOpened` / `onClosed`（パスのクエリ・ハッシュは含まない） | なし | Background が配信。Chrome はネイティブのイベント、Firefox はパネルと Background の間の `runtime.Port` の切断で検出し、`page` は両方とも完全な URL |
| 開閉の完了 | `close()` はパネルが閉じる前に完了する | — | 状態が反映されるまで待ってから完了（最大 1 秒） |
| アイコンのクリックで開閉 | `setPanelBehavior()`（設定を保存） | なし | 両方とも `action.onClicked` で実装し、起動ごとに登録 |
| ページ設定 | 全体・タブごと | 全体・ウィンドウごと・タブごと | 全体のみ（タブごとは開閉の単位が異なるため提供しない） |
| 既定ページに戻す | なし | `setPanel({ panel: null })` | Chrome は Manifest の値を設定 |
| インストール時の表示 | 開かない | 既定で開く | Manifest で `open_at_install: false` を指定（[はじめに](getting-started.md)） |

## 実行場所の判定

| 項目 | ブラウザ差 | ライブラリ |
| --- | --- | --- |
| Background | Chrome は Service Worker、Firefox はイベントページ | どちらも `kind: 'background'`（実装の種類は公開しない） |
| サイドパネルの同期判定 | Firefox だけ同期的に判定できる | 両方とも `resolve()` で判定 |
| popout の元の UI | — | `'popup'` / `'side-panel'` で統一 |

## ストレージ

| 項目 | ブラウザ差 | ライブラリ |
| --- | --- | --- |
| `toString` などのトップレベルのキー | Firefox の `storage.session` で読み戻せない | 全ブラウザ・全領域で `INVALID_ARGUMENT`（namespace 内では使える） |
| 変化のない書き込み | Firefox は `onChanged` を通知することがある | 変化のない通知は配信しない |
| Content Script からの `session` | アクセスレベルの設定が必要 | Background 経由で操作し、`contentScriptAccess` で制御 |
| 容量の上限 | Firefox の `local` は動的 | 移行前に既知の上限で検査し、最終的な判定はブラウザに任せる |

## popout

| 項目 | ブラウザ差 | ライブラリ |
| --- | --- | --- |
| ポップアップのページ取得 | Chrome はタブ単位、Firefox はウィンドウ単位も可 | `sourceTarget.windowId` はアクティブなタブとして解決 |
| 新しいウィンドウの初期 URL | Firefox は一時的に `about:blank` | 読み込み完了まで待って照合 |
| 呼び出し元を閉じる | サイドパネルは Firefox でユーザー操作が必要 | `closeOriginal` はポップアップのみ |

## messaging

| 項目 | ブラウザ差 | ライブラリ |
| --- | --- | --- |
| 非同期応答 | 実装の細部が異なる | 内部で `sendResponse` と `return true` を使い、同じ結果にする |
| MAIN world との通信 | Firefox はワールド間でオブジェクトを渡すと制約がある | JSON 文字列の `CustomEvent` で通信 |
| `browser` / `chrome` | Firefox は両方、Chrome は `chrome` | メソッドごとに存在を確認して使う |

## ライブラリの外にある差

次の差は、ブラウザ（または拡張機能のビルド）の側で解決する必要があります。

- **Manifest の書式**: Background（`service_worker` / `scripts`）、サイドパネル（`side_panel` / `sidebar_action`）、Firefox の `browser_specific_settings` など。例は [はじめに](getting-started.md) と [examples](../examples/README.md) にあります。
- **ユーザー操作の判定**: `await` の後もユーザー操作として扱うかはブラウザが決めます。サイドパネルの開閉は、ユーザー操作のハンドラー内で `await` を挟まずに呼んでください（両方のブラウザで確実に動きます）。
