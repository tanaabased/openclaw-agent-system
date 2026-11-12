/** human report label only; never rename a scheduler job or its destination. */
export default function automationReportName(schedulerName: unknown, id: string): string {
  const name =
    typeof schedulerName === 'string' ? schedulerName.replace(/\p{RGI_Emoji}/gv, '').trim() : '';
  return (name || id.replaceAll('-', ' ')).toUpperCase();
}
