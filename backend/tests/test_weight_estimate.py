"""Weight estimates stay separate from visual decisions and never imply scale data."""
import json
from unittest.mock import Mock

import httpx
import pytest
from PIL import Image

from backend.cameras import CameraMonitor
from backend.common import ServiceError
from backend.config import Settings
from backend.vision import LunaClient


@pytest.mark.parametrize('grams', [245, None])
def test_weight_request_contract(grams):
    calls = []

    def provider(request):
        calls.append(json.loads(request.content))
        return httpx.Response(200, json={
            'status': 'completed',
            'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps({
                'estimated_weight_g': grams, 'explanation': 'Typical empty item; contents unknown.',
            })}]}],
        })

    client = LunaClient(Settings(openai_api_key='fake'), httpx.MockTransport(provider))
    try:
        value = client.estimate_weight({'id': 'bottle', 'name': 'Bottle'}, Image.new('RGB', (50, 50)))
    finally:
        client.close()
    assert value['estimated_weight_g'] == grams
    assert calls[0]['store'] is False
    assert calls[0]['text']['format']['name'] == 'item_weight_estimate'
    assert calls[0]['text']['format']['strict'] is True
    assert calls[0]['input'][1]['content'][1]['type'] == 'input_image'


def make_monitor():
    verifier = Mock()
    verifier.verify.return_value = {'identified_product': {'id': 'bottle', 'name': 'Bottle'}, 'decision': 'consistent'}
    verifier.estimate_weight.return_value = {'estimated_weight_g': 245, 'explanation': 'Empty bottle estimate.'}
    monitor = CameraMonitor(verifier)
    monitor.ids = (0, 1)
    return monitor, verifier


def test_two_cameras_make_one_weight_request():
    monitor, verifier = make_monitor()
    result = monitor._verify([b'front', b'side'], 123)
    assert len(result['results']) == 2
    verifier.estimate_weight.assert_called_once_with(b'front', {'id': 'bottle', 'name': 'Bottle'}, inspection={'decision': 'consistent'})
    assert result['weight_estimate']['simulated'] is True
    assert result['weight_estimate']['source'] == 'luna_estimate'
    assert result['results'][0]['result']['decision'] == 'consistent'


def test_estimate_failure_preserves_visual_results():
    monitor, verifier = make_monitor()
    verifier.estimate_weight.side_effect = ServiceError('provider unavailable', 503)
    result = monitor._verify([b'front', b'side'], 123)
    assert len(result['results']) == 2
    assert 'weight_estimate' not in result
    assert 'unavailable' in result['weight_estimate_error']


def test_no_identification_does_not_guess_mass():
    monitor, verifier = make_monitor()
    verifier.verify.return_value = {'identified_product': None}
    result = monitor._verify([b'front', b'side'], 123)
    verifier.estimate_weight.assert_not_called()
    assert 'weight_estimate' not in result


def test_second_camera_can_supply_identity_after_first_fails():
    monitor, verifier = make_monitor()
    verifier.verify.side_effect = [ServiceError('bad view'), {'identified_product': {'id': 'bottle', 'name': 'Bottle'}}]
    result = monitor._verify([b'front', b'side'], 123)
    verifier.estimate_weight.assert_called_once_with(b'side', {'id': 'bottle', 'name': 'Bottle'}, inspection={})
    assert result['weight_estimate']['estimated_weight_g'] == 245


@pytest.mark.parametrize('grams', [-10, 0, float('inf'), float('nan'), 1000001])
def test_invalid_mass_is_rejected(grams):
    client = LunaClient(Settings())
    client.request = Mock(return_value=({'estimated_weight_g': grams, 'explanation': 'Invalid'}, 0))
    with pytest.raises(ServiceError, match='invalid'):
        client.estimate_weight({'name': 'Bottle'}, Image.new('RGB', (50, 50)))


def test_replica_without_identified_product_gets_actual_object_estimate():
    monitor, verifier = make_monitor()
    findings = {
        'identified_product': None,
        'compared_product': {'id': 'iphone', 'name': 'iPhone'},
        'decision': 'suspicious',
        'flags': {'different_item': {'status': 'present'}},
        'discrepancies': [{'description': 'Visible plastic layer lines; possible printed mockup'}],
    }
    verifier.verify.return_value = findings
    verifier.estimate_weight.return_value = {'estimated_weight_g': 45, 'explanation': 'Assuming hollow printed plastic; fill unknown.'}
    result = monitor._verify([b'front', b'side'], 123)
    args, kwargs = verifier.estimate_weight.call_args
    assert args == (b'front', findings['compared_product'])
    assert kwargs['inspection']['discrepancies'] == findings['discrepancies']
    assert result['weight_estimate']['estimated_weight_g'] == 45
    assert result['weight_estimate']['product_name'] == 'Returned item (reference: iPhone)'
    assert result['results'][0]['result']['decision'] == 'suspicious'


def test_discrepant_camera_is_preferred_for_weight_context():
    monitor, verifier = make_monitor()
    verifier.verify.side_effect = [
        {'identified_product': {'id': 'phone', 'name': 'Phone'}, 'decision': 'consistent'},
        {'identified_product': None, 'compared_product': {'id': 'phone', 'name': 'Phone'}, 'decision': 'suspicious'},
    ]
    monitor._verify([b'front', b'side'], 123)
    assert verifier.estimate_weight.call_count == 1
    assert verifier.estimate_weight.call_args.args[0] == b'side'
    assert verifier.estimate_weight.call_args.kwargs['inspection']['decision'] == 'suspicious'


def test_weight_prompt_does_not_substitute_genuine_weight_for_replica():
    client = LunaClient(Settings())
    client.request = Mock(return_value=({'estimated_weight_g': 45, 'explanation': 'Possible hollow plastic mockup'}, 0))
    context = {'decision': 'suspicious', 'discrepancies': [{'description': 'Possible 3D printed shell'}]}
    client.estimate_weight({'name': 'iPhone'}, Image.new('RGB', (50, 50)), inspection=context)
    args = client.request.call_args.args
    assert 'ACTUAL RETURNED OBJECT' in args[0]
    assert "NOT the genuine product's specification" in args[0]
    assert json.loads(args[1][0]['text'])['inspection'] == context
