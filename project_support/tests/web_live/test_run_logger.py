"""The run log is a file; the console is for what somebody has to act on.

Every `log()` used to print itself to stdout as well as writing the record. A
manual flight session logs a sample ten times a second, so a 443 s session put
4,484 `manual_sample: 수동 비행 상태` lines through the terminal and the one
`battery_low` warning in the middle went past with them.
"""
import json

from data.python.aerodt.data.run_logger import RunLogger


def test_routine_records_are_written_but_not_repeated_on_the_console(tmp_path, capsys):
    logger = RunLogger(tmp_path, 'manual_flight', {'plan': 'x'})
    for index in range(3):
        logger.log('manual_sample', '수동 비행 상태', data={'sample': index})
    assert capsys.readouterr().out == '', 'a ten-a-second sample does not belong on the terminal'
    written = [json.loads(line) for line in logger.events_path.read_text(encoding='utf-8').splitlines()]
    assert [record['event'] for record in written] == ['manual_sample'] * 3
    assert [record['data']['sample'] for record in written] == [0, 1, 2], 'the record keeps everything it kept before'
    assert written[0]['level'] == 'info' and written[0]['component'] == 'user_application.manual_flight'
    assert written[0]['timestamp'] and written[0]['message'] == '수동 비행 상태'


def test_a_warning_or_error_still_reaches_the_person_watching(tmp_path, capsys):
    logger = RunLogger(tmp_path, 'manual_flight', {})
    logger.log('battery_low', '배터리 부족 기록 — 강제 추락 없음', level='warning')
    logger.log('native_failed', '물리 실행 오류', level='error')
    logger.log('manual_sample', '수동 비행 상태')
    printed = capsys.readouterr().out
    assert 'battery_low' in printed and '배터리 부족' in printed
    assert 'native_failed' in printed
    assert 'manual_sample' not in printed, 'the flood stays out even when a warning is around it'
    assert len([line for line in printed.splitlines() if line.strip()]) == 2
    # All three are still in the file: the console choice never edits the record.
    assert len(logger.events_path.read_text(encoding='utf-8').splitlines()) == 3


def test_the_manifest_is_written_and_closed_without_printing(tmp_path, capsys):
    logger = RunLogger(tmp_path, 'web_dashboard', {'sources': ['fixture']})
    logger.log('started', 'Web Live Twin started; source status is authoritative')
    logger.finish('stopped')
    assert capsys.readouterr().out == ''
    manifest = json.loads(logger.manifest_path.read_text(encoding='utf-8'))
    assert manifest['status'] == 'stopped' and manifest['finished_at']
    assert manifest['run_id'] == logger.run_id and manifest['metadata'] == {'sources': ['fixture']}
