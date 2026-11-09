/**
 * 浏览器里的小工具：复制到剪贴板、下载一个文件。
 *
 * 都得兜住「浏览器不给用」的情况：
 * 剪贴板 API 要权限，下载要能造 Blob，
 * 任何一个不可用都不该让整页报错。
 */

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 老浏览器没有剪贴板 API，退回选中+execCommand。
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

export function downloadText(
  filename: string,
  text: string,
  mime = "application/json",
): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
