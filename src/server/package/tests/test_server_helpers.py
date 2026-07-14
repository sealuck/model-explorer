import json
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import model_explorer.server as server
from model_explorer.server import (
    _find_mdbg,
    _parse_node_data_paths,
    _validate_focus_request,
)


def test_find_mdbg_from_repo_working_directory_after_wheel_install(
    monkeypatch, tmp_path
):
  repo_root = tmp_path / 'repo'
  mdbg = repo_root / 'build' / 'bin' / 'mdbg'
  mdbg.parent.mkdir(parents=True)
  mdbg.touch()

  installed_server = (
      tmp_path / 'venv' / 'site-packages' / 'model_explorer' / 'server.py'
  )
  monkeypatch.setattr(server, '__file__', str(installed_server))
  monkeypatch.chdir(repo_root)
  monkeypatch.delenv('MDBG_BIN', raising=False)
  monkeypatch.delenv('MDBG', raising=False)
  monkeypatch.setattr(server.shutil, 'which', lambda _: None)

  assert _find_mdbg() == str(mdbg)


def test_find_mdbg_accepts_adapter_environment_variable(monkeypatch, tmp_path):
  mdbg = tmp_path / 'mdbg'
  mdbg.touch()
  monkeypatch.delenv('MDBG_BIN', raising=False)
  monkeypatch.setenv('MDBG', str(mdbg))

  assert _find_mdbg() == str(mdbg)


def test_validate_focus_request_rejects_invalid_mode():
  error = _validate_focus_request(['%a'], 'bad', 'none', 'all', {})

  assert 'Invalid mode' in error


def test_validate_focus_request_rejects_single_with_many_seeds():
  error = _validate_focus_request(['%a', '%b'], 'single', 'none', 'all', {})

  assert 'single requires exactly one seed' in error


def test_validate_focus_request_rejects_multi_modes_with_one_seed():
  union_error = _validate_focus_request(['%a'], 'union', 'none', 'all', {})
  inter_seed_error = _validate_focus_request(
      ['%a'], 'inter-seed', 'none', 'all', {}
  )

  assert 'union requires at least two seeds' in union_error
  assert 'inter-seed requires at least two seeds' in inter_seed_error


def test_validate_focus_request_rejects_legacy_direction_depth():
  direction_error = _validate_focus_request(
      ['%a'], 'single', 'none', 'all', {'direction': 'both'}
  )
  depth_error = _validate_focus_request(
      ['%a'], 'single', 'none', 'all', {'depth': '2'}
  )

  assert 'context' in direction_error
  assert 'context_depth' in direction_error
  assert 'context' in depth_error
  assert 'context_depth' in depth_error


def test_validate_focus_request_rejects_invalid_context_params():
  context_error = _validate_focus_request(['%a'], 'single', 'bad', 'all', {})
  depth_error = _validate_focus_request(['%a'], 'single', 'none', 'bad', {})

  assert 'Invalid context' in context_error
  assert 'Invalid context_depth' in depth_error


def test_validate_focus_request_accepts_arbitrary_nonnegative_depth():
  # Depths beyond the legacy 0/1/2 set are valid; the CLI accepts any integer.
  for depth in ('0', '1', '2', '3', '7', '42', 'all'):
    assert (
        _validate_focus_request(['%a'], 'single', 'downstream', depth, {})
        is None
    )


def test_validate_focus_request_rejects_negative_or_noninteger_depth():
  # Only non-negative integers or 'all' are valid; reject the rest loudly.
  for depth in ('-1', '1.5', 'two', ''):
    error = _validate_focus_request(['%a'], 'single', 'downstream', depth, {})
    assert error is not None
    assert 'Invalid context_depth' in error


def test_parse_node_data_paths_accepts_comma_and_colon_separators():
  assert _parse_node_data_paths('/tmp/a.json, /tmp/b.json:/tmp/c.json') == [
      '/tmp/a.json',
      '/tmp/b.json',
      '/tmp/c.json',
  ]


def test_focus_route_forwards_node_data_without_seed_roles(monkeypatch, tmp_path):
  app = _capture_app(monkeypatch)
  subgraph = {
      'graphs': [{
          'id': 'main',
          'nodes': [{
              'id': 'seed',
              'attrs': [{'key': 'mdbg_seed_role', 'value': 'seed'}],
          }],
      }]
  }
  accuracy_path = str(tmp_path / 'accuracy.json')
  extra_path = str(tmp_path / 'extra.json')

  monkeypatch.setattr(server, '_find_mdbg', lambda: '/bin/mdbg')

  def fake_run(args, capture_output, text, timeout):
    return SimpleNamespace(
        returncode=0,
        stdout=json.dumps(subgraph),
        stderr='',
    )

  monkeypatch.setattr(server.subprocess, 'run', fake_run)

  response = app.test_client().get(
      '/focus',
      query_string={
          'graph_path': '/tmp/graph.json',
          'seed': '%seed',
          'mode': 'single',
          'node_data_paths': f'{accuracy_path}:{extra_path}',
      },
  )

  assert response.status_code == 302
  data = _redirect_data(response.headers['Location'])
  assert data['nodeData'] == [accuracy_path, extra_path]
  assert not any('seed_roles' in path for path in data['nodeData'])

  graph_path = Path(data['models'][0]['url'])
  assert graph_path.name == 'subgraph.json'
  assert json.loads(graph_path.read_text()) == subgraph
  assert not (graph_path.parent / 'seed_roles.json').exists()


def test_focus_route_finds_mdbg_and_runs_multiple_seeds_from_installed_wheel(
    monkeypatch, tmp_path
):
  app = _capture_app(monkeypatch)
  repo_root = tmp_path / 'repo'
  mdbg = repo_root / 'build' / 'bin' / 'mdbg'
  mdbg.parent.mkdir(parents=True)
  mdbg.touch()
  monkeypatch.setattr(
      server,
      '__file__',
      str(tmp_path / 'venv' / 'site-packages' / 'model_explorer' / 'server.py'),
  )
  monkeypatch.chdir(repo_root)
  monkeypatch.delenv('MDBG_BIN', raising=False)
  monkeypatch.delenv('MDBG', raising=False)
  monkeypatch.setattr(server.shutil, 'which', lambda _: None)
  captured_args = []

  def fake_run(args, capture_output, text, timeout):
    captured_args.extend(args)
    return SimpleNamespace(
        returncode=0,
        stdout=json.dumps({'label': 'focused', 'graphs': []}),
        stderr='',
    )

  monkeypatch.setattr(server.subprocess, 'run', fake_run)

  response = app.test_client().get(
      '/focus',
      query_string=[
          ('graph_path', '/tmp/graph.json'),
          ('seed', '%a'),
          ('seed', '%b'),
          ('mode', 'union'),
          ('context', 'both'),
          ('context_depth', '2'),
      ],
  )

  assert response.status_code == 302
  assert captured_args == [
      str(mdbg),
      'dataflow',
      '--graph',
      '/tmp/graph.json',
      '--mode',
      'union',
      '--context',
      'both',
      '--context-depth',
      '2',
      '-o',
      '-',
      '--seed',
      '%a',
      '--seed',
      '%b',
  ]


def _capture_app(monkeypatch):
  captured = {}

  def fake_run(self, *args, **kwargs):
    captured['app'] = self

  monkeypatch.setattr(server, '_is_port_in_use', lambda host, port: False)
  monkeypatch.setattr(server, '_check_new_version', lambda *args, **kwargs: {})
  monkeypatch.setattr(server.Flask, 'run', fake_run)

  server.start(
      port=9000,
      no_open_in_browser=True,
      skip_health_check=True,
      extensions=[],
  )
  return captured['app']


def _redirect_data(location: str) -> dict:
  query = parse_qs(urlparse(location).query)
  return json.loads(query['data'][0])
