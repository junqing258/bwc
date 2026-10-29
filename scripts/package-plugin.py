"""Build a single-plugin ZIP separately from the CLI marketplace tarball."""
import json
import sys
import zipfile
from pathlib import Path, PurePosixPath


def validate(path):
    if not zipfile.is_zipfile(path):
        raise ValueError("请选择单插件 .zip；marketplace 的 .tar.gz 需要解压后用 CLI 安装")
    with zipfile.ZipFile(path) as archive:
        names = {name.rstrip('/') for name in archive.namelist() if not name.endswith('/')}
        for name in names:
            parts = PurePosixPath(name)
            if parts.is_absolute() or '..' in parts.parts:
                raise ValueError("ZIP 包含越界路径")
        if 'plugin.json' in names:
            prefix = ''
        else:
            roots = {name.split('/')[0] for name in names}
            if len(roots) != 1:
                raise ValueError("插件目录必须为唯一顶层目录，不能混入 .agents/marketplace 等同级文件")
            prefix = next(iter(roots)) + '/'
            if prefix + 'plugin.json' not in names:
                raise ValueError("ZIP 根目录或唯一顶层目录内缺少 plugin.json")
        manifest = json.loads(archive.read(prefix + 'plugin.json'))
        if not all(isinstance(manifest.get(key), str) and manifest[key] for key in ('name', 'version', 'description')):
            raise ValueError("plugin.json 缺少 name、version 或 description")
        skills = [name for name in names if name.startswith(prefix + 'skills/') and name.endswith('/SKILL.md')]
        if not skills:
            raise ValueError("插件中没有有效的 Skills 入口")
        mcp = json.loads(archive.read(prefix + 'mcp.json'))
        servers = mcp.get('mcpServers', {})
        if not servers:
            raise ValueError("mcp.json 没有声明 MCP 服务")
        for server in servers.values():
            if server.get('type') != 'stdio' or not server.get('command'):
                raise ValueError("BWC 发行包需要显式 stdio 配置与启动命令")
            for arg in server.get('args', []):
                if '${CLAUDE_PLUGIN_ROOT}' in arg:
                    raise ValueError("请使用已验证的 ${PLUGIN_ROOT} 路径变量")
                if arg.startswith('${PLUGIN_ROOT}/') and prefix + arg[len('${PLUGIN_ROOT}/'):] not in names:
                    raise ValueError("MCP 启动文件未随包分发")
        if archive.testzip() is not None:
            raise ValueError("ZIP CRC 校验失败")
        return {'valid': True, 'name': manifest['name'], 'version': manifest['version'],
                'pluginRoot': prefix or '.', 'skills': len(skills), 'mcpServers': list(servers),
                'files': len(names), 'format': 'single-plugin-zip'}


def build(root, output):
    root = Path(root).resolve()
    output = Path(output).resolve()
    if not (root / 'plugin.json').is_file():
        raise ValueError("请选择包含 plugin.json 的插件目录，而不是 marketplace 父目录")
    if output.is_relative_to(root):
        raise ValueError("ZIP 输出必须位于插件目录之外")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + '.tmp')
    try:
        with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for file in sorted(root.rglob('*')):
                if file.is_file() and file.name != '.DS_Store':
                    archive.write(file, file.relative_to(root).as_posix())
        result = validate(temporary)
        temporary.replace(output)
        return result
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        if len(sys.argv) == 3 and sys.argv[1] == '--validate':
            result = validate(sys.argv[2])
        elif len(sys.argv) == 3:
            result = build(sys.argv[1], sys.argv[2])
        else:
            raise ValueError("用法：package-plugin.py <插件目录> <输出.zip>；或 --validate <ZIP>")
        print(json.dumps(result, ensure_ascii=False))
    except (ValueError, OSError, KeyError, zipfile.BadZipFile) as error:
        print(json.dumps({'valid': False, 'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
