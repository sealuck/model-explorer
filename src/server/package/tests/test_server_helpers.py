from model_explorer.server import (
    _build_seed_roles,
    _parse_node_data_paths,
    _validate_focus_request,
)


def _sample_graph():
  return {
      'graphs': [{
          'id': 'main',
          'nodes': [
              {
                  'id': 'node-a',
                  'attrs': [{'key': 'mdbg_source_ssa', 'value': '%a'}],
              },
              {
                  'id': 'node-b',
                  'attrs': [{'key': 'mdbg_source_ssa', 'value': '%b, %b_alias'}],
              },
              {
                  'id': 'node-c',
                  'attrs': [{'key': 'mdbg_source_ssa', 'value': '%c'}],
              },
              {
                  'id': 'node-d',
                  'attrs': [{'key': 'other', 'value': '%a'}],
              },
          ],
      }]
  }


def test_build_seed_roles_marks_single_seed_by_ssa():
  roles = _build_seed_roles(_sample_graph(), '%a')

  assert roles == {
      'main': {
          'name': 'Seed roles',
          'results': {'node-a': {'bgColor': '#4e9af1'}},
      }
  }


def test_build_seed_roles_marks_many_seeds_by_ssa_and_node_id():
  roles = _build_seed_roles(_sample_graph(), '%a,%b_alias,nodeId:node-c')

  assert roles['main']['results'] == {
      'node-a': {'bgColor': '#4e9af1'},
      'node-b': {'bgColor': '#4e9af1'},
      'node-c': {'bgColor': '#4e9af1'},
  }
  assert 'node-d' not in roles['main']['results']


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


def test_parse_node_data_paths_accepts_comma_and_colon_separators():
  assert _parse_node_data_paths('/tmp/a.json, /tmp/b.json:/tmp/c.json') == [
      '/tmp/a.json',
      '/tmp/b.json',
      '/tmp/c.json',
  ]
