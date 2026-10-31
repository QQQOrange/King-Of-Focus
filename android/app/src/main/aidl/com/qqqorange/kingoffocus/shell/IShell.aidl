package com.qqqorange.kingoffocus.shell;

/**
 * 跑在 Shizuku（shell 身份）里的用户服务接口。
 *
 * 为什么要有它：Shizuku API 13 把 `newProcess` 收成了 private，官方只留
 * "用户服务"这一条路——把一段自己的代码以 shell 身份跑起来，再通过 Binder 调它。
 * 我们只需要一个能力：执行一条 shell 命令，拿回输出。
 *
 * 注意：这个接口一旦改动（方法签名、顺序），**必须**同步调大
 * `Shizuku.UserServiceArgs.version(...)`，否则 Shizuku 会复用旧的进程导致
 * "调到了不存在的方法"。
 */
interface IShell {
    /** 执行一条命令，返回合并后的 stdout/stderr；执行失败返回以 "ERR:" 开头的字符串 */
    String exec(String cmd);
}
