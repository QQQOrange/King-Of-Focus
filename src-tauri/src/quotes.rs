//! 励志短语：定时联网取一条（一言 hitokoto），失败就用本地兜底

use crate::cfg;
use crate::model::{Config, QuoteFeed};
use crate::shared::Shared;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

const FALLBACK: [(&str, &str); 14] = [
    ("你今天做的事，是你明天想成为的人。", ""),
    ("专注不是天赋，是一次次把手拉回眼前的事。", ""),
    ("现在忍住的那一下，就是你以后的底气。", ""),
    ("把时间花在哪里，你就会长成什么样子。", ""),
    ("进度慢一点没关系，方向对就行。", ""),
    ("不需要靠意志力撑完，只要再撑五分钟。", ""),
    ("想放弃的时候，先把手上的这一段做完。", ""),
    ("自律的本质，是把选择权留给自己。", ""),
    ("你不是没有时间，你是把时间给了别的东西。", ""),
    ("今天先赢一小局，明天再赢一局。", ""),
    ("注意力就是你最贵的资产，别随便送人。", ""),
    ("熬得住，才配得上。", ""),
    ("安静地做，别急着要结果。", ""),
    ("所有看起来的轻松，背后都是苦功。", ""),
];

fn cache_path() -> PathBuf {
    cfg::data_dir().join("quote.json")
}

/// 明显消极的词：命中即丢弃这条语录。
///
/// 这是一份"宁可错杀"的短名单——它只负责挡住最刺眼的那一类，
/// 真正的保底是「内置精选」那 120 条人工筛过的句子。
/// 注意**没有**收 `放弃`："不要放弃"本身是正向的，标了反而会误杀。
const NEG_WORDS: [&str; 26] = [
    "死亡", "去世", "自杀", "绝望", "崩溃", "抑郁", "想死", "坟墓", "葬礼", "眼泪",
    "哭泣", "失恋", "分手", "离婚", "仇恨", "痛苦", "悲伤", "遗憾", "后悔", "颓废",
    "堕落", "麻木", "失眠", "心碎", "末日", "人间不值得",
];

/// 否定词：紧挨在消极词前面时，这句话其实是在"反着说"（不孤单 / 别难过），放行。
const NEGATIONS: [char; 5] = ['不', '别', '没', '勿', '无'];

/// 这句话够不够"正向"？
///
/// 规则很短，但每条都有理由：
/// 1. 长度 4~60 字：太短没信息量，太长会把 Hub 那块撑开；
/// 2. 不许有换行 / 制表：接口偶尔返回整段，取第一行以外的都算脏数据；
/// 3. 命中消极词、且**前面没有否定词** → 丢。
pub fn positive_ok(text: &str) -> bool {
    let t = text.trim();
    let n = t.chars().count();
    if !(4..=60).contains(&n) {
        return false;
    }
    if t.contains('\n') || t.contains('\t') || t.contains("//") {
        return false;
    }
    for w in NEG_WORDS.iter() {
        let mut from = 0usize;
        while let Some(rel) = t[from..].find(w) {
            let at = from + rel;
            let prev = t[..at].chars().next_back();
            let negated = prev.map(|c| NEGATIONS.contains(&c)).unwrap_or(false);
            if !negated {
                return false;
            }
            from = at + w.len();
        }
    }
    true
}

/// 当前选中的来源（找不到就退回列表第一个）
pub fn active_feed(cfg: &Config) -> Option<QuoteFeed> {
    let list = &cfg.settings.quote_feeds;
    let id = cfg.settings.quote_feed.trim();
    list.iter()
        .find(|f| f.id == id)
        .or_else(|| list.first())
        .cloned()
}

pub fn feed_by_id(cfg: &Config, id: &str) -> Option<QuoteFeed> {
    cfg.settings
        .quote_feeds
        .iter()
        .find(|f| f.id == id.trim())
        .cloned()
}

/// 从任意 JSON 里挑一句：先认一言的字段，再退到通用的 text/content/sentence。
fn pick_json(v: &serde_json::Value) -> Option<(String, String)> {
    let get = |k: &str| v.get(k).and_then(|x| x.as_str()).map(|x| x.trim().to_string());
    let text = get("hitokoto")
        .or_else(|| get("text"))
        .or_else(|| get("content"))
        .or_else(|| get("sentence"))
        .or_else(|| get("quote"))?;
    // 出处尽量给全：一言同时给「作品名」和「作者」，只有作品名时也照实标。
    // 界面把它显示成 "—— 作者《作品》"，让人一眼知道这句是从哪来的。
    let work = get("from").unwrap_or_default();
    let who = get("from_who")
        .or_else(|| get("author"))
        .or_else(|| get("source"))
        .unwrap_or_default();
    let from = match (who.is_empty(), work.is_empty()) {
        (false, false) => format!("{who}《{work}》"),
        (false, true) => who,
        (true, false) => format!("《{work}》"),
        (true, true) => String::new(),
    };
    Some((text, from))
}

/// 按来源取一条。`None` = 没取到（网络失败、地址不通、或句子没过正向过滤）。
///
/// 刻意把"过滤掉"和"网络挂了"混成一个返回值：对界面来说两者一样——
/// 都退回本地池；区别只在日志里。
pub fn fetch_feed(f: &QuoteFeed) -> Option<(String, String)> {
    // 连试两次：过滤掉一句很常见，一次就放弃会让「换一条」经常落空
    for _ in 0..2 {
        let raw = crate::net::get_text(&f.url, None, None).ok()?;
        let pair = if f.kind == "text" {
            let head = raw.lines().next().unwrap_or("").trim().to_string();
            if head.is_empty() {
                None
            } else {
                Some((head, String::new()))
            }
        } else {
            serde_json::from_str::<serde_json::Value>(&raw)
                .ok()
                .and_then(|v| pick_json(&v))
        };
        if let Some((t, from)) = pair {
            if positive_ok(&t) {
                return Some((t, from));
            }
        }
    }
    None
}

pub fn save_cache(text: &str, from: &str) {
    let body = serde_json::json!({"text": text, "from": from, "ts": chrono::Local::now().timestamp()});
    if let Ok(s) = serde_json::to_string(&body) {
        let _ = std::fs::write(cache_path(), s);
    }
}

fn load_cache() -> Option<(String, String)> {
    let s = std::fs::read_to_string(cache_path()).ok()?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    Some((
        v.get("text")?.as_str()?.to_string(),
        v.get("from").and_then(|x| x.as_str()).unwrap_or("").to_string(),
    ))
}

pub fn set_quote(shared: &Shared, text: String, from: String) {
    if let Ok(mut rt) = shared.rt.lock() {
        rt.quote = text;
        rt.quote_from = from;
    }
}

pub fn start(shared: Arc<Shared>) {
    // 先用缓存或兜底，保证第一屏就有字
    let first = load_cache().unwrap_or_else(|| {
        let i = (chrono::Local::now().timestamp() as usize) % FALLBACK.len();
        (FALLBACK[i].0.to_string(), FALLBACK[i].1.to_string())
    });
    set_quote(&shared, first.0, first.1);

    thread::spawn(move || {
        thread::sleep(Duration::from_secs(3));
        let mut idx = 0usize;
        loop {
            let cfg = shared.config();
            let mins = cfg.settings.hud.quote_minutes.clamp(5, 1440) as u64;

            // HUD 跟着界面选的来源走：同一份配置，不该出现"Hub 是一言的、悬浮条是另一家的"
            let feed = active_feed(&cfg);
            let got = match (cfg.settings.hud.enabled, feed) {
                (true, Some(f)) if f.kind != "local" => fetch_feed(&f),
                _ => None,
            };
            match got {
                Some((t, f)) => {
                    save_cache(&t, &f);
                    set_quote(&shared, t, f);
                }
                None => {
                    // 网络挂了：本地轮换，不至于一直显示同一句
                    idx = (idx + 1) % FALLBACK.len();
                    set_quote(&shared, FALLBACK[idx].0.to_string(), FALLBACK[idx].1.to_string());
                }
            }
            thread::sleep(Duration::from_secs(mins * 60));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{default_quote_feeds, Config};

    /// 正向句子必须放行——过滤器不能把正常的话也挡掉
    #[test]
    fn keeps_encouraging_lines() {
        for t in [
            "今天多做一点，明天就少难一点。",
            "专注不是天赋，是一次次把手拉回来。",
            "你走的每一步，都算数。",
        ] {
            assert!(positive_ok(t), "被误杀：{t}");
        }
    }

    /// 明显消极的句子必须挡掉
    #[test]
    fn drops_gloomy_lines() {
        for t in [
            "反正最后都是绝望。",
            "努力有什么用，我早就崩溃了。",
            "人间不值得，何必认真。",
        ] {
            assert!(!positive_ok(t), "漏网：{t}");
        }
    }

    /// 否定词紧贴在前面时，其实是在反着鼓励（"不必后悔"），要放行
    #[test]
    fn negation_flips_the_meaning() {
        assert!(positive_ok("选了就别后悔，往前看。"));
        assert!(positive_ok("一个人也不孤独，安静也很好。"));
    }

    /// 太短 / 太长 / 带换行的都算脏数据
    #[test]
    fn rejects_bad_shape() {
        assert!(!positive_ok("加油"));
        assert!(!positive_ok(&"很长的句子".repeat(40)));
        assert!(!positive_ok("第一行\n第二行"));
        assert!(!positive_ok("   "));
    }

    /// 中文按字符算长度，不能按字节——否则 15 个汉字就被误判成"太长"
    #[test]
    fn length_counts_chars_not_bytes() {
        let s = "把时间花在哪里，你就会长成什么样子。今天多做一点，明天就少难一点。";
        assert!(s.len() > 60, "这句的字节数应当超过 60");
        assert!(s.chars().count() < 60);
        assert!(positive_ok(s), "按字符算就不该被判成太长");
    }

    /// 默认来源：三个内置，本地那个永远排第一（离线兜底）
    #[test]
    fn default_feeds_start_with_local() {
        let f = default_quote_feeds();
        assert_eq!(f.len(), 3);
        assert_eq!(f[0].id, "local");
        assert_eq!(f[0].kind, "local");
        assert!(f[0].builtin);
        assert!(f[1].url.starts_with("https://"));
    }

    /// 选中的来源不存在时退回列表第一个，而不是返回 None 让界面空白
    #[test]
    fn active_feed_falls_back() {
        let mut c = Config::default();
        c.settings.quote_feeds = default_quote_feeds();
        c.settings.quote_feed = "not-there".into();
        assert_eq!(active_feed(&c).map(|f| f.id), Some("local".into()));
        c.settings.quote_feed = "hitokoto".into();
        assert_eq!(active_feed(&c).map(|f| f.id), Some("hitokoto".into()));
    }
}
