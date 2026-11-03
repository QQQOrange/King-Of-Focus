//! 运行日志 —— 给"用户说不清哪里坏了"这种情况留证据。
//!
//! ## 为什么要自己写一个
//!
//! 这是个 `WinExe`（没有控制台），`eprintln!` 的输出谁也看不到；`panic = "abort"`
//! 让崩溃直接消失、不留痕迹。结果是：用户说"它有时候会自己退出 / 规则不生效"，
//! 手上能查的东西是零。
//!
//! 所以这里维护一个**滚动日志文件** + **崩溃快照**：
//!   - `logs/app.log`      正常运行日志，超过 1.5MB 就滚成 `app.1.log`
//!   - `logs/crash-*.txt`  每次 panic 一份，带 backtrace
//!
//! 「关于 → 导出诊断信息」会把版本、环境、脱敏后的配置和日志尾巴打成一份文本，
//! 用户直接发过来就行，不用教他去哪个目录找文件。

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

/// 单个日志文件的上限：超过就滚动。日志是给排障用的，不是数据。
const MAX_BYTES: u64 = 1_500_000;
/// 导出诊断时带多少行日志尾巴
const TAIL_LINES: usize = 400;

static FILE: Mutex<Option<std::fs::File>> = Mutex::new(None);

pub fn dir() -> PathBuf {
    crate::cfg::data_dir().join("logs")
}

/// 启动时调用一次：建目录、开文件、必要时滚动。
pub fn init() {
    let d = dir();
    let _ = std::fs::create_dir_all(&d);
    let p = d.join("app.log");
    // 滚动只在这里做：写路径上不要每行都 stat 一次
    if let Ok(md) = std::fs::metadata(&p) {
        if md.len() > MAX_BYTES {
            let _ = std::fs::rename(&p, d.join("app.1.log"));
        }
    }
    let f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&p)
        .ok();
    if let Ok(mut g) = FILE.lock() {
        *g = f;
    }
}

/// 写一行。`tag` 用短词（boot / cfg / sync / update / mask / pan），方便 grep。
pub fn write(tag: &str, msg: &str) {
    let line = format!(
        "{} [{tag}] {}\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
        msg.trim_end()
    );
    // 从 `--diag` 之类的控制台启动时还能看到一份
    eprint!("{line}");
    if let Ok(mut g) = FILE.lock() {
        if let Some(f) = g.as_mut() {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

/// 安装 panic 钩子。`panic = "abort"` 下钩子仍会先执行，然后进程退出。
pub fn install_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let bt = std::backtrace::Backtrace::force_capture();
        let text = format!("{info}\n\n{bt}");
        write("pan", &text.replace('\n', "\n    "));
        // 单独留一份，用户能直接发出来
        let p = dir().join(format!(
            "crash-{}.txt",
            chrono::Local::now().format("%Y%m%d-%H%M%S")
        ));
        let head = format!(
            "King Of Focus {} · {} · {}\n\n",
            crate::version::VERSION,
            std::env::consts::OS,
            std::env::consts::ARCH
        );
        let _ = std::fs::write(p, head + &text);
        prev(info);
    }));
}

/// 最近的日志（给「导出诊断」用）
pub fn tail() -> String {
    let p = dir().join("app.log");
    let Ok(s) = std::fs::read_to_string(&p) else {
        return "（没有日志文件）".into();
    };
    let lines: Vec<&str> = s.lines().collect();
    let from = lines.len().saturating_sub(TAIL_LINES);
    lines[from..].join("\n")
}
