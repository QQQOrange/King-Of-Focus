use crate::model::{AppEntry, Rule};
use crate::proc::{norm_path, stem, WinApp};

/// 大小写不敏感的通配符匹配，支持 * 和 ?
pub fn glob(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == t[ti] || p[pi] == '?') {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = pi;
            pi += 1;
            mark = ti;
        } else if star != usize::MAX {
            pi = star + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

fn contains_nocase(hay: &str, needle: &str) -> bool {
    hay.to_lowercase().contains(&needle.to_lowercase())
}

pub fn app_matches(entry: &AppEntry, app: &WinApp) -> bool {
    let v = entry.value.trim();
    if v.is_empty() {
        return false;
    }
    match entry.kind.as_str() {
        "exe" => {
            if app.path.is_empty() {
                // 拿不到路径时退化为进程名匹配
                let file = v.rsplit(['\\', '/']).next().unwrap_or(v);
                return stem(file) == app.name || glob(&stem(file), &app.name);
            }
            norm_path(&app.path) == norm_path(v)
        }
        "dir" => {
            let dir = norm_path(v);
            if app.path.is_empty() {
                return false;
            }
            norm_path(&app.path).starts_with(&dir)
        }
        "name" => {
            if v.contains('*') || v.contains('?') {
                glob(v, &app.name)
            } else {
                stem(v) == app.name
            }
        }
        "title" => {
            if v.contains('*') || v.contains('?') {
                glob(v, &app.title)
            } else {
                contains_nocase(&app.title, v)
            }
        }
        _ => false,
    }
}

pub fn rule_blocks_app(rule: &Rule, app: &WinApp) -> bool {
    rule.apps.iter().any(|e| app_matches(e, app))
}

/// 强制模式下，这个进程是否"该被放行"
pub fn rule_allows_app(rule: &Rule, app: &WinApp) -> bool {
    rule.apps.iter().any(|e| app_matches(e, app))
}

/// 是否属于"系统级 / 保护"进程，任何情况下都不拦
pub fn is_protected(app: &WinApp, protected: &[String]) -> bool {
    if app.path.is_empty() {
        return true; // 拿不到路径的一律放过，避免误杀
    }
    let p = norm_path(&app.path);
    if p.starts_with("c:\\windows\\") {
        return true; // 系统目录里的进程一律放过
    }
    if protected.iter().any(|n| n.to_lowercase() == app.name) {
        return true;
    }
    if app.name.is_empty() {
        return true;
    }
    false
}

pub const BROWSERS: [&str; 16] = [
    "chrome", "msedge", "firefox", "brave", "opera", "vivaldi", "chromium", "360se",
    "360chrome", "qqbrowser", "sogouexplorer", "liebao", "maxthon", "arc", "thorium",
    "zen",
];

/// 用户自己登记的浏览器进程名（小写、不含 .exe）。
/// 内置清单认不出小众套壳，但"自律时段里打开浏览器要被拦"必须对它们同样成立。
static EXTRA_BROWSERS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

pub fn set_extra_browsers(list: Vec<String>) {
    if let Ok(mut g) = EXTRA_BROWSERS.lock() {
        *g = list.into_iter()
            .map(|x| x.trim().to_lowercase())
            .filter(|x| !x.is_empty())
            .collect();
    }
}

/// 进程名是不是某个浏览器（内置清单 + 用户登记的自定义浏览器）。
///
/// 不能用 `contains`：`arc` 会命中 `arcsoft`、`opera` 命中 `operadriver`、
/// `zen` 命中 `frozen`、`chrome` 命中 `chromedriver` —— 浏览器守护一开，
/// 这些无关进程会被当成浏览器直接结束掉。只接受"完全相等"和两种明确变体：
/// 纯数字后缀（360se6）与 `_proxy`（chrome_proxy）。
pub fn is_browser_name(name: &str) -> bool {
    let lower = name.trim().to_lowercase();
    let name = lower.trim_end_matches(".exe");
    if name.is_empty() {
        return false;
    }
    if BROWSERS.iter().any(|b| browser_stem_match(&name, b)) {
        return true;
    }
    EXTRA_BROWSERS
        .lock()
        .map(|g| g.iter().any(|x| browser_stem_match(&name, x)))
        .unwrap_or(false)
}

fn browser_stem_match(name: &str, stem: &str) -> bool {
    if name == stem {
        return true;
    }
    match name.strip_prefix(stem) {
        Some(rest) => {
            rest == "_proxy"
                || (!rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()))
        }
        None => false,
    }
}

pub fn is_browser(app: &WinApp) -> bool {
    is_browser_name(&app.name)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 浏览器判定不能用子串：`arc` 命中 arcsoft、`opera` 命中 operadriver，
    /// 浏览器守护会把这些无关进程当成浏览器结束掉。
    #[test]
    fn browser_match_is_exact_not_substring() {
        assert!(is_browser_name("chrome"));
        assert!(is_browser_name("msedge"));
        assert!(is_browser_name("chrome_proxy"), "扩展用的代理进程算浏览器");
        assert!(is_browser_name("360se6"), "数字后缀是已知变体");
        assert!(is_browser_name("Chrome.EXE"), "大小写与后缀要归一化");
        assert!(!is_browser_name("arcsoft"), "arcsoft 不是浏览器");
        assert!(!is_browser_name("operadriver"));
        assert!(!is_browser_name("chromedriver"));
        assert!(!is_browser_name("frozen"));
        assert!(!is_browser_name(""));
    }
}
