select jobid, jobname, schedule, command, nodename, nodeport, database
from cron.job
order by jobid;