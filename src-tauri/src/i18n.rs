//! Strings shown by the native side (dialogs, window titles). The page has its own dictionary.

pub fn system_is_chinese() -> bool {
    sys_locale::get_locale().map(|l| l.to_ascii_lowercase().starts_with("zh")).unwrap_or(false)
}

/// Resolves the "auto" setting to a concrete language.
pub fn effective(setting: &str) -> &'static str {
    match setting {
        "zh-CN" => "zh-CN",
        "en" => "en",
        _ => {
            if system_is_chinese() { "zh-CN" } else { "en" }
        }
    }
}

pub fn t(lang: &str, key: &str) -> &'static str {
    let zh = lang == "zh-CN";
    match key {
        "untitled" => if zh { "未命名" } else { "Untitled" },
        "filter.markdown" => if zh { "Markdown 文件" } else { "Markdown files" },
        "filter.text" => if zh { "文本文件" } else { "Text files" },
        "filter.all" => if zh { "所有文件" } else { "All files" },
        "open.title" => if zh { "打开 Markdown 文件" } else { "Open a Markdown file" },
        "save.title" => if zh { "保存 Markdown 文件" } else { "Save Markdown file" },
        "local.title" => if zh { "打开本地文件？" } else { "Open a local file?" },
        "local.body" => if zh {
            "这份文档链接到一个本地文件。为了安全，Inkleaf 不会直接运行它，只会在资源管理器里选中它：\n\n"
        } else {
            "This document links to a local file. For safety, Inkleaf will not run it; it can only show it in File Explorer:\n\n"
        },
        "local.show" => if zh { "在资源管理器中显示" } else { "Show in File Explorer" },
        "cancel" => if zh { "取消" } else { "Cancel" },
        "unsaved.title" => if zh { "有未保存的修改" } else { "Unsaved changes" },
        "unsaved.body" => if zh { "要保存对这份文档的修改吗？" } else { "Do you want to save the changes to this document?" },
        "unsaved.save" => if zh { "保存" } else { "Save" },
        "unsaved.discard" => if zh { "不保存" } else { "Don't save" },
        "err.not_doc" => if zh { "只能打开 Markdown 或文本文件：" } else { "Only Markdown or text files can be opened: " },
        "err.too_large" => if zh { "文件太大（超过 20 MB），无法打开：" } else { "The file is larger than 20 MB and cannot be opened: " },
        "err.not_found" => if zh { "找不到文件：" } else { "File not found: " },
        "err.is_dir" => if zh { "这是一个文件夹，请拖入或选择 Markdown 文件：" } else { "That is a folder. Drop or choose a Markdown file instead: " },
        "err.read" => if zh { "无法读取文件：" } else { "Could not read the file: " },
        "err.save" => if zh { "保存失败：" } else { "Could not save: " },
        "notice.utf8" => if zh {
            "文档里有原编码无法表示的字符，已改为 UTF-8 保存。"
        } else {
            "The document contains characters its original encoding cannot store, so it was saved as UTF-8."
        },
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_languages_and_keys() {
        assert_eq!(effective("en"), "en");
        assert_eq!(effective("zh-CN"), "zh-CN");
        assert!(matches!(effective("auto"), "en" | "zh-CN"));
        for key in ["untitled", "local.body", "unsaved.save", "err.too_large", "notice.utf8"] {
            assert!(!t("en", key).is_empty(), "{key}");
            assert!(!t("zh-CN", key).is_empty(), "{key}");
            assert_ne!(t("en", key), t("zh-CN", key));
        }
    }
}
