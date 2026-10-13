import process from 'node:process';
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('ECHO_READY\r\n');
process.stdin.on('data',data=>{if(data.includes(3))process.exit(0);process.stdout.write(data);});
