#!/bin/sh
# auditd の記録の容量: 20MB×5 世代=100MB で回す(secguard の容量の割り当て)。空きが減ったら syslog に知らせる。
f=/etc/audit/auditd.conf
set_kv() { if grep -q "^$1 *=" $f; then sed -i "s|^$1 *=.*|$1 = $2|" $f; else echo "$1 = $2" >> $f; fi; }
set_kv max_log_file 20
set_kv num_logs 5
set_kv max_log_file_action ROTATE
set_kv space_left_action SYSLOG
set_kv admin_space_left_action SYSLOG
set_kv disk_full_action ROTATE
