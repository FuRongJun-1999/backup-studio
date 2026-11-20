interface Props {
  /** 相对根目录的 POSIX 路径 */
  value: string;
  className?: string;
}

/**
 * 长文件名：中间省略号，后缀（扩展名）完整保留。
 *
 * 做法是把主文件名劈成两半：
 *  - head 用 flex 吸收压缩空间，硬裁切
 *  - tail 以 rtl 方向收缩，省略号落在左侧，露出的是文件名末尾
 * 两段拼起来即「头部…尾部」的中间省略形态。
 */
function splitStem(stem: string): [string, string] {
  if (stem.length <= 28) return [stem, ''];
  const mid = Math.ceil(stem.length / 2);
  return [stem.slice(0, mid), stem.slice(mid)];
}

export function FileName({ value, className }: Props) {
  const segments = value.split('/');
  const name = segments.pop() ?? '';
  const dir = segments.join('/');

  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0;
  const stem = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';
  const [head, tail] = splitStem(stem);

  return (
    <span className={className ? `filename ${className}` : 'filename'} title={value}>
      {dir ? <span className="filename-dir">{dir}/</span> : null}
      <span className="filename-stem">
        <span className="filename-head">{head}</span>
        {tail ? <span className="filename-tail">{tail}</span> : null}
      </span>
      {ext ? <span className="filename-ext">{ext}</span> : null}
    </span>
  );
}
